import { describe, expect, test } from "bun:test";
import type { RealtimeSidebandEvent } from "./protocol";
import { ChatGptRealtimeTransport } from "./transport";

class FakeSocket {
  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, Array<(event: any) => void>>();
  addEventListener(type: string, listener: (event: any) => void): void {
    const values = this.listeners.get(type) ?? [];
    values.push(listener);
    this.listeners.set(type, values);
  }
  send(data: string): void { this.sent.push(data); }
  close(_code?: number, reason = ""): void {
    this.readyState = 3;
    this.emit("close", { reason });
  }
  open(): void { this.readyState = 1; this.emit("open", {}); }
  message(value: unknown): void { this.emit("message", { data: JSON.stringify(value) }); }
  private emit(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const session = {
  accessToken: "token-1",
  accountId: "account-1",
  accountKey: "key-1",
};

describe("native ChatGPT realtime transport", () => {
  test("creates the call with Exocortex auth and joins the direct sideband", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const sockets: Array<{ url: string; headers: Record<string, string>; socket: FakeSocket }> = [];
    const events: RealtimeSidebandEvent[] = [];
    const transport = new ChatGptRealtimeTransport({
      callsUrl: "https://chatgpt.test/backend-api/codex/realtime/calls",
      sidebandBaseUrl: "wss://api.test/v1/live",
      getSession: async () => session,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        return new Response("v=0\r\no=answer", {
          status: 200,
          headers: { Location: "/v1/live/rtc_native_test" },
        });
      }) as typeof fetch,
      createWebSocket: (url, headers) => {
        const socket = new FakeSocket();
        sockets.push({ url, headers, socket });
        queueMicrotask(() => socket.open());
        return socket;
      },
      onEvent: event => { events.push(event); },
    });

    const result = await transport.start({
      offerSdp: "v=0\r\no=offer",
      prompt: "voice prompt",
      initialItems: [{ role: "user", text: "context" }],
      voice: "cove",
      sessionId: "session-1",
      threadId: "thread-1",
    });
    expect(result).toEqual({ answerSdp: "v=0\r\no=answer", callId: "rtc_native_test" });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://chatgpt.test/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas");
    const headers = new Headers(requests[0]!.init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer token-1");
    expect(headers.get("ChatGPT-Account-ID")).toBe("account-1");
    expect(headers.get("openai-alpha")).toBe("quicksilver=v2");
    expect(headers.get("session-id")).toBe("session-1");
    expect(headers.get("thread-id")).toBe("thread-1");
    const body = JSON.parse(String(requests[0]!.init?.body));
    expect(body.sdp).toBe("v=0\r\no=offer");
    expect(body.session.delegation).toEqual({ type: "client" });
    expect(body.session.initial_items[0].content[0].text).toBe("context");

    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toBe("wss://api.test/v1/live/rtc_native_test");
    expect(sockets[0]!.headers.Authorization).toBe("Bearer token-1");
    sockets[0]!.socket.message({
      type: "turn.done",
      turn: { role: "user", transcript: "hello" },
    });
    expect(events).toContainEqual({ type: "transcript_done", role: "user", text: "hello" });

    await transport.appendHandoff("delegation-1", "done");
    expect(sockets[0]!.socket.sent.map(value => JSON.parse(value))).toContainEqual({
      type: "delegation.context.append",
      delegation_item_id: "delegation-1",
      channel: "speakable",
      content: [{ type: "input_text", text: "done" }],
    });
    await transport.stop();
    expect(sockets[0]!.socket.sent.map(value => JSON.parse(value))).toContainEqual({ type: "session.close" });
  });

  test("cancels a sideband that is still connecting", async () => {
    const sockets: FakeSocket[] = [];
    const transport = new ChatGptRealtimeTransport({
      getSession: async () => session,
      fetch: (async () => new Response("v=0\r\no=answer", {
        status: 200,
        headers: { Location: "/v1/live/rtc_connecting" },
      })) as unknown as typeof fetch,
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const starting = transport.start({ offerSdp: "v=0", prompt: "p", initialItems: [], voice: "cove" })
      .then(() => null, error => error as Error);
    for (let attempt = 0; attempt < 10 && sockets.length === 0; attempt++) await Promise.resolve();
    expect(sockets).toHaveLength(1);

    await transport.stop();
    const startError = await starting;
    expect(sockets[0]!.readyState).toBe(3);
    expect(startError).toBeInstanceOf(Error);
    expect(startError!.message).toContain("stopped");
  });

  test("uses Exocortex forced refresh once after a call-create 401", async () => {
    const forceRefresh: boolean[] = [];
    let calls = 0;
    const socket = new FakeSocket();
    const transport = new ChatGptRealtimeTransport({
      getSession: async options => {
        forceRefresh.push(options?.forceRefresh === true);
        return { ...session, accessToken: options?.forceRefresh ? "token-2" : "token-1" };
      },
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        calls++;
        if (calls === 1) return new Response("unauthorized", { status: 401 });
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token-2");
        return new Response("v=0\r\no=answer", {
          status: 200,
          headers: { Location: "/v1/live/rtc_refreshed" },
        });
      }) as typeof fetch,
      createWebSocket: () => {
        queueMicrotask(() => socket.open());
        return socket;
      },
    });

    await transport.start({ offerSdp: "v=0", prompt: "p", initialItems: [], voice: "cove" });
    expect(forceRefresh).toEqual([false, true]);
    expect(calls).toBe(2);
    await transport.stop();
  });
});
