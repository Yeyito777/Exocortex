/**
 * Gemini provider backed by the Antigravity CLI (`agy acp`), Google's
 * official agent CLI for Google AI Pro/Ultra plans, over the Agent Client
 * Protocol.
 *
 * Conversation turns run the CLI's own agent (its system prompt, tools,
 * GEMINI.md/AGENTS.md and skills) in the conversation's workspace, with
 * Exocortex's instructions appended to its system prompt and Exocortex's host
 * tools (exo, chrono, ...) offered over MCP; Exocortex streams and records
 * what it does (session.ts, stream.ts). One-shot helper requests (titles,
 * summaries, compaction) run in a throwaway session.
 *
 * Every request goes through the CLI's own Google sign-in, so it draws on
 * the plan's quota; API-key environment overrides are stripped (cli.ts), and
 * the CLI's AI-credit overage stays off (its default).
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { log } from "../../log";
import { createAbortError } from "../../abort";
import type { ApiMessage, ModelId } from "../../messages";
import type { StreamCallbacks, StreamOptions, StreamResult } from "../types";
import { getModelInfo } from "../registry";
import { hostToolDefs } from "../anthropic/host-tools";
import { AcpProcess } from "./acp";
import { noteGeminiSignInWorking, requireGeminiAuth } from "./auth";
import { agyBinary, agyEnv } from "./cli";
import { agyModelLevel } from "./models";
import { buildGeminiHelperPrompt, buildGeminiPromptContent, planGeminiPrompt } from "./prompt";
import { fingerprintOf, getGeminiProcess, openGeminiProcess, translateAcpError } from "./session";
import { createGeminiStreamState } from "./stream";

/** Conversation turns carry Exocortex's tool surface; helper calls do not. */
function isAgentTurn(options: StreamOptions): boolean {
  return Array.isArray(options.tools) && options.tools.length > 0;
}

export async function streamMessage(
  messages: ApiMessage[],
  model: ModelId,
  callbacks: StreamCallbacks,
  options: StreamOptions = {},
): Promise<StreamResult> {
  const { signal } = options;
  await requireGeminiAuth(signal);
  if (signal?.aborted) throw createAbortError();
  const convId = options.tracking?.conversationId;
  const result = convId && isAgentTurn(options)
    ? await runAgentTurn(convId, messages, model, callbacks, options)
    : await runHelper(messages, model, callbacks, options);
  noteGeminiSignInWorking();
  return result;
}

async function runAgentTurn(convId: string, messages: ApiMessage[], model: ModelId, callbacks: StreamCallbacks, options: StreamOptions): Promise<StreamResult> {
  const { signal } = options;
  const cwd = options.workingDirectory ?? process.cwd();
  const system = options.system ?? "";
  const key = { cwd, fingerprint: fingerprintOf(system, hostToolDefs(options.tools)) };
  const plan = planGeminiPrompt(messages, cwd);
  const modelInfo = getModelInfo("gemini", model);

  let live = getGeminiProcess(convId);
  const continues = !!live && live.matches(key) && !live.busy && !!plan.resume
    && live.sessionId === plan.resume.sessionId && live.head === plan.resume.mark;
  let pending = plan.pending;
  if (!continues) {
    live?.close(live.busy ? "a new turn started while it was busy"
      : !live.matches(key) ? "its workspace, instructions or tool text changed"
      : `the conversation moved on from it (session ${live.sessionId} at ${live.head ?? "none"}, history at ${plan.resume ? `${plan.resume.sessionId} ${plan.resume.mark}` : "no resumable point"})`);
    live = openGeminiProcess(convId, key, system, options.tools);
    try {
      await live.initialize();
      const loaded = await live.openSession(plan.resume?.sessionId ?? null);
      if (loaded && plan.resume) live.head = plan.resume.mark;
      // A session that could not be loaded saw nothing: send the whole history.
      if (!loaded) pending = messages;
    } catch (error) {
      live.close("it failed to start");
      throw translateAcpError(error);
    }
  }
  const proc = live!;
  log("info", `gemini: turn for ${convId} (model=${model}, effort=${options.effort ?? "default"}, cwd=${cwd}, session=${proc.sessionId}, ${continues ? "running process" : plan.resume ? "loaded session" : "new session"}, pending=${pending.length})`);
  try {
    await proc.configure(model, modelInfo, options.effort);
  } catch (error) {
    throw translateAcpError(error);
  }
  const state = createGeminiStreamState(callbacks, cwd, proc.sessionId!);
  return proc.prompt(state, buildGeminiPromptContent(pending), options.toolExecutor, signal);
}

/** One-shot helper request: a throwaway session in an empty directory, no Exocortex tools. */
async function runHelper(messages: ApiMessage[], model: ModelId, callbacks: StreamCallbacks, options: StreamOptions): Promise<StreamResult> {
  const { signal } = options;
  const cwd = join(tmpdir(), "exocortex-gemini-helper");
  mkdirSync(cwd, { recursive: true });
  const acp = new AcpProcess({
    binary: agyBinary(),
    args: ["acp"],
    cwd,
    env: agyEnv(),
    onNotification: (method, params) => {
      if (method !== "session/update" || params.sessionId !== sessionId) return;
      const update = params.update as Record<string, unknown> | undefined;
      const text = (update?.content as { text?: unknown } | undefined)?.text;
      if (update?.sessionUpdate === "agent_message_chunk" && typeof text === "string") {
        output += text;
        callbacks.onText(text);
      } else {
        callbacks.onActivity?.();
      }
    },
    // A helper runs no tools: refuse anything that asks.
    onRequest: () => ({ outcome: { outcome: "cancelled" } }),
  });
  let sessionId: string | null = null;
  let output = "";
  const onAbort = () => acp.close();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await acp.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const system = [
      options.system,
      "Answer directly in plain text. Do not use any tools.",
    ].filter(Boolean).join("\n\n");
    const created = await acp.request<Record<string, unknown>>("session/new", { cwd, mcpServers: [], _meta: { antigravity: { systemPrompt: { append: system } } } });
    sessionId = String(created.sessionId);
    await acp.request("session/set_config_option", { sessionId, configId: "model", value: model });
    await acp.request("session/set_config_option", { sessionId, configId: "thought_level", value: agyModelLevel(getModelInfo("gemini", model), options.effort ?? "low") }).catch(() => {});
    const result = await acp.request<Record<string, unknown>>("session/prompt", { sessionId, prompt: [{ type: "text", text: buildGeminiHelperPrompt(messages) }] });
    if (signal?.aborted) throw createAbortError();
    const usage = (result.usage ?? {}) as Record<string, number>;
    const text = output.trim();
    return {
      text,
      thinking: "",
      stopReason: "stop",
      blocks: text ? [{ type: "text", text }] : [],
      toolCalls: [],
      inputTokens: (usage.inputTokens ?? 0) + (usage.cachedReadTokens ?? 0),
      outputTokens: (usage.outputTokens ?? 0) + (usage.thoughtTokens ?? 0),
    };
  } catch (error) {
    if (signal?.aborted) throw createAbortError();
    throw translateAcpError(error);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    acp.close();
  }
}
