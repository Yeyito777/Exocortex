import { randomUUID } from "node:crypto";
import { buildOpenAIHeaders } from "../providers/openai/http";
import { OPENAI_CODEX_REALTIME_CALLS_URL } from "../providers/openai/constants";
import { getVerifiedSession, type VerifiedOpenAISession } from "../providers/openai/auth";
import { log } from "../log";
import {
  buildDelegationAppend,
  buildRealtimeSession,
  parseRealtimeSidebandEvent,
  type RealtimeInitialItem,
  type RealtimeSidebandEvent,
} from "./protocol";
import type { RealtimeVoice } from "@exocortex/shared/realtime";

export interface NativeRealtimeStartParams {
  offerSdp: string;
  prompt: string;
  initialItems: RealtimeInitialItem[];
  sessionId?: string;
  threadId?: string;
  voice: RealtimeVoice;
}

export interface NativeRealtimeStartResult {
  answerSdp: string;
  callId: string;
}

export interface NativeRealtimeTransport {
  start(params: NativeRealtimeStartParams): Promise<NativeRealtimeStartResult>;
  appendHandoff(handoffId: string, text: string): Promise<void>;
  stop(): Promise<void>;
}

interface WebSocketLike {
  readonly readyState: number;
  addEventListener(type: "open" | "error" | "close" | "message", listener: (event: any) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface NativeRealtimeTransportOptions {
  fetch?: typeof fetch;
  createWebSocket?: (url: string, headers: Record<string, string>) => WebSocketLike;
  getSession?: (options?: { forceRefresh?: boolean }) => Promise<VerifiedOpenAISession>;
  callsUrl?: string;
  sidebandBaseUrl?: string;
  onEvent?: (event: RealtimeSidebandEvent) => void | Promise<void>;
}

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const SIDEBAND_RETRIES = 3;

function defaultWebSocket(url: string, headers: Record<string, string>): WebSocketLike {
  // Bun accepts request headers in its WebSocket options. Keep the cast local so
  // the rest of the call stack depends only on the small WebSocketLike contract.
  return new WebSocket(url, { headers } as unknown as string[]) as unknown as WebSocketLike;
}

function callIdFromLocation(location: string | null): string {
  if (!location) throw new Error("Realtime call response is missing its Location header.");
  const path = location.split("?", 1)[0] ?? location;
  const segment = path.split("/").reverse().find(candidate => (
    candidate.startsWith("rtc_") && candidate.length > 4
  ) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate));
  if (!segment) throw new Error("Realtime call Location does not contain a call ID.");
  return segment;
}

function requestHeaders(
  session: VerifiedOpenAISession,
  sessionId: string,
  threadId: string,
): Record<string, string> {
  return buildOpenAIHeaders({
    Authorization: `Bearer ${session.accessToken}`,
    ...(session.accountId ? { "ChatGPT-Account-ID": session.accountId } : {}),
    "openai-alpha": "quicksilver=v2",
    "x-session-id": sessionId,
    "session-id": sessionId,
    "thread-id": threadId,
  });
}

function sidebandUrl(baseUrl: string, callId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(callId)}`;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Native ChatGPT Frameless-Bidi transport; no Codex process or package involved. */
export class ChatGptRealtimeTransport implements NativeRealtimeTransport {
  private socket: WebSocketLike | null = null;
  private connectingSocket: WebSocketLike | null = null;
  private stopped = false;
  private accountId: string | null = null;
  private sidebandTask: Promise<void> | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly createSocket: NonNullable<NativeRealtimeTransportOptions["createWebSocket"]>;
  private readonly getSession: NonNullable<NativeRealtimeTransportOptions["getSession"]>;
  private readonly callsUrl: string;
  private readonly sidebandBaseUrl: string;
  private readonly onEvent: NonNullable<NativeRealtimeTransportOptions["onEvent"]>;

  constructor(options: NativeRealtimeTransportOptions = {}) {
    this.fetchFn = options.fetch ?? fetch;
    this.createSocket = options.createWebSocket ?? defaultWebSocket;
    this.getSession = options.getSession ?? getVerifiedSession;
    this.callsUrl = options.callsUrl ?? OPENAI_CODEX_REALTIME_CALLS_URL;
    this.sidebandBaseUrl = options.sidebandBaseUrl ?? "wss://api.openai.com/v1/live";
    this.onEvent = options.onEvent ?? (() => {});
  }

  async start(params: NativeRealtimeStartParams): Promise<NativeRealtimeStartResult> {
    if (this.socket || this.sidebandTask) throw new Error("Realtime transport is already started.");
    this.stopped = false;
    const sessionId = params.sessionId ?? randomUUID();
    const threadId = params.threadId ?? randomUUID();
    let session = await this.requireAccount(await this.getSession());
    let response = await this.createCall(params, session, sessionId, threadId);
    if (response.status === 401) {
      session = await this.requireAccount(await this.getSession({ forceRefresh: true }));
      response = await this.createCall(params, session, sessionId, threadId);
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1_000);
      throw new Error(`Realtime call creation failed (${response.status}): ${detail || response.statusText}`);
    }
    const answerSdp = await response.text();
    if (!answerSdp.startsWith("v=0")) throw new Error("Realtime call returned an invalid SDP answer.");
    const callId = callIdFromLocation(response.headers.get("location"));
    const headers = requestHeaders(session, sessionId, threadId);
    const sidebandTask = this.connectSideband(callId, headers);
    this.sidebandTask = sidebandTask;
    try {
      // A call is not usable without its client-managed delegation sideband.
      // Do not report it live merely because the SDP exchange succeeded.
      await sidebandTask;
    } catch (error) {
      if (this.sidebandTask === sidebandTask) this.sidebandTask = null;
      throw error;
    }
    return { answerSdp, callId };
  }

  async appendHandoff(handoffId: string, text: string): Promise<void> {
    for (const message of buildDelegationAppend(handoffId, text)) this.send(message);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const socket = this.socket;
    const connectingSocket = this.connectingSocket;
    this.socket = null;
    this.connectingSocket = null;
    if (connectingSocket && connectingSocket !== socket) {
      try { connectingSocket.close(); } catch { /* best effort */ }
    }
    if (socket?.readyState === WS_OPEN) {
      try { socket.send(JSON.stringify({ type: "session.close" })); } catch { /* best effort */ }
      try { socket.close(1000, "call ended"); } catch { /* best effort */ }
    } else if (socket?.readyState === WS_CONNECTING) {
      try { socket.close(); } catch { /* best effort */ }
    }
    await Promise.race([this.sidebandTask?.catch(() => {}) ?? Promise.resolve(), wait(1_000)]);
    this.sidebandTask = null;
    this.accountId = null;
  }

  private async requireAccount(session: VerifiedOpenAISession): Promise<VerifiedOpenAISession> {
    if (!session.accountId) {
      throw new Error("The selected OpenAI account has no ChatGPT workspace ID; reconnect it with /login openai.");
    }
    if (this.accountId && session.accountId !== this.accountId) {
      throw new Error("The selected OpenAI account changed during the realtime call.");
    }
    this.accountId = session.accountId;
    return session;
  }

  private createCall(
    params: NativeRealtimeStartParams,
    session: VerifiedOpenAISession,
    sessionId: string,
    threadId: string,
  ): Promise<Response> {
    const url = new URL(this.callsUrl);
    url.searchParams.set("intent", "quicksilver");
    url.searchParams.set("architecture", "avas");
    return this.fetchFn(url, {
      method: "POST",
      headers: {
        ...requestHeaders(session, sessionId, threadId),
        Accept: "application/sdp",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sdp: params.offerSdp,
        session: buildRealtimeSession(params.prompt, params.initialItems, params.voice),
      }),
    });
  }

  private async connectSideband(callId: string, headers: Record<string, string>): Promise<void> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < SIDEBAND_RETRIES && !this.stopped; attempt++) {
      try {
        await this.connectSidebandOnce(callId, headers);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt + 1 < SIDEBAND_RETRIES && !this.stopped) await wait(200 * 2 ** attempt);
      }
    }
    if (this.stopped) throw new Error("Realtime sideband connection was stopped.");
    throw lastError ?? new Error("Realtime sideband connection failed.");
  }

  private connectSidebandOnce(callId: string, headers: Record<string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = this.createSocket(sidebandUrl(this.sidebandBaseUrl, callId), headers);
      this.connectingSocket = socket;
      let opened = false;
      let settled = false;
      const forgetConnectingSocket = () => {
        if (this.connectingSocket === socket) this.connectingSocket = null;
      };
      const openTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        forgetConnectingSocket();
        try { socket.close(); } catch { /* best effort */ }
        reject(new Error("Realtime sideband connection timed out."));
      }, 10_000);
      openTimer.unref?.();

      socket.addEventListener("open", () => {
        if (settled) {
          try { socket.close(); } catch { /* best effort */ }
          return;
        }
        settled = true;
        clearTimeout(openTimer);
        forgetConnectingSocket();
        if (this.stopped) {
          try { socket.close(); } catch { /* best effort */ }
          reject(new Error("Realtime sideband connection was stopped."));
          return;
        }
        opened = true;
        this.socket = socket;
        resolve();
      });
      socket.addEventListener("message", event => {
        if (this.socket !== socket || typeof event.data !== "string") return;
        const parsed = parseRealtimeSidebandEvent(event.data);
        if (parsed) Promise.resolve(this.onEvent(parsed)).catch(error => {
          log("warn", `realtime call: event handler failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      });
      socket.addEventListener("error", () => {
        if (!opened && !settled) {
          settled = true;
          clearTimeout(openTimer);
          forgetConnectingSocket();
          try { socket.close(); } catch { /* best effort */ }
          reject(new Error("Realtime sideband WebSocket failed to connect."));
        }
      });
      socket.addEventListener("close", event => {
        clearTimeout(openTimer);
        forgetConnectingSocket();
        if (this.socket === socket) this.socket = null;
        if (!opened && !settled) {
          settled = true;
          reject(new Error(`Realtime sideband closed during connection${event.reason ? `: ${event.reason}` : "."}`));
          return;
        }
        if (opened && !this.stopped) {
          void this.onEvent({ type: "closed", ...(event.reason ? { reason: event.reason } : {}) });
        }
      });
    });
  }

  private send(message: Record<string, unknown>): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WS_OPEN) throw new Error("Realtime sideband is not connected.");
    socket.send(JSON.stringify(message));
  }
}
