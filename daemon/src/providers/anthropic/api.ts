/**
 * Claude Agent SDK-backed Anthropic runtime.
 */

import { query, type EffortLevel as ClaudeEffortLevel, type Options as ClaudeQueryOptions, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createAbortError } from "../../abort";
import { log } from "../../log";
import { type ModelId, type ApiMessage } from "../../messages";
import type { StreamResult, StreamCallbacks, StreamOptions } from "../types";
import { AuthError } from "../errors";
import { getClaudeAuthStatus, getClaudeBinary, getClaudeVersion } from "./cli";
import { createExocortexMcpServer, getExocortexAllowedToolNames } from "./mcp-tools";
import { buildClaudePrompt, buildClaudeSdkUserMessage, extractResumeSessionId, resolveClaudeModel, supportsClaudeEffort } from "./prompt";
import { createClaudeStreamProcessor, finalizeClaudeStream, pushClaudeEvent } from "./stream";

function toClaudeEffort(effort: StreamOptions["effort"]): ClaudeEffortLevel | undefined {
  if (effort === "low" || effort === "medium" || effort === "high" || effort === "max") return effort;
  return undefined;
}

/**
 * Anthropic uses the presence of the Exocortex MCP bridge to distinguish the
 * full chat runtime from restricted helper calls (titlegen, inner llm(), etc).
 */
function isHelperProfile(options: StreamOptions): boolean {
  return !options.mcpToolExecutor;
}

function toSdkPrompt(messages: ApiMessage[], resumeSessionId: string | null, helperProfile: boolean): string | AsyncIterable<SDKUserMessage> {
  if (helperProfile) {
    return buildClaudePrompt(messages, resumeSessionId);
  }

  return {
    async *[Symbol.asyncIterator]() {
      yield buildClaudeSdkUserMessage(messages, resumeSessionId);
    },
  };
}

function buildClaudeQueryOptions(messages: ApiMessage[], model: ModelId, options: StreamOptions): ClaudeQueryOptions {
  const helperProfile = isHelperProfile(options);
  const resumeSessionId = helperProfile ? null : extractResumeSessionId(messages);
  const systemPrompt = options.system;

  const effort = supportsClaudeEffort(model) ? toClaudeEffort(options.effort) : undefined;

  const queryOptions: ClaudeQueryOptions = {
    cwd: process.cwd(),
    model: resolveClaudeModel(model),
    pathToClaudeCodeExecutable: getClaudeBinary(),
    includePartialMessages: true,
    env: {
      ...process.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: "exocortex-daemon",
    },
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(effort ? { effort } : {}),
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
  };

  if (helperProfile) {
    return {
      ...queryOptions,
      tools: [],
      permissionMode: "dontAsk",
      settingSources: [],
      maxTurns: 1,
    };
  }

  return {
    ...queryOptions,
    // Remove Claude Code built-ins entirely; Anthropic chats should only see
    // the Exocortex MCP tool surface we provide below.
    tools: [],
    mcpServers: options.mcpToolExecutor
      ? { exocortex: createExocortexMcpServer(options.mcpToolExecutor) }
      : undefined,
    allowedTools: options.mcpToolExecutor ? getExocortexAllowedToolNames() : undefined,
    permissionMode: "bypassPermissions",
    // Keep Anthropic chats isolated from CLAUDE.md / Claude settings so the
    // Exocortex prompt and tool model remain authoritative.
    settingSources: [],
  };
}

async function ensureClaudeReady(signal?: AbortSignal): Promise<void> {
  await getClaudeVersion(signal);
  const status = await getClaudeAuthStatus(signal);
  if (!status.loggedIn) {
    throw new AuthError("Anthropic is not authenticated. Run `claude auth login`.");
  }
}

export async function streamMessage(
  messages: ApiMessage[],
  model: ModelId,
  callbacks: StreamCallbacks,
  options: StreamOptions = {},
): Promise<StreamResult> {
  const { signal } = options;
  await ensureClaudeReady(signal);

  const helperProfile = isHelperProfile(options);
  const resumeSessionId = helperProfile ? null : extractResumeSessionId(messages);
  const sdkPrompt = toSdkPrompt(messages, resumeSessionId, helperProfile);
  const queryOptions = buildClaudeQueryOptions(messages, model, options);

  log("info", `anthropic: starting Claude SDK session (model=${resolveClaudeModel(model)}, resume=${resumeSessionId ? "yes" : "no"}, helper=${helperProfile ? "yes" : "no"})`);

  const runtime = query({
    prompt: sdkPrompt,
    options: queryOptions,
  });

  const processor = createClaudeStreamProcessor(callbacks);
  const onAbort = () => {
    try {
      runtime.close();
    } catch {
      // best-effort
    }
  };

  if (signal) {
    if (signal.aborted) {
      onAbort();
      throw createAbortError();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    for await (const message of runtime) {
      if (signal?.aborted) throw createAbortError();
      pushClaudeEvent(processor, message as unknown as Record<string, unknown>);
    }
    if (signal?.aborted) throw createAbortError();
    return finalizeClaudeStream(processor);
  } catch (error) {
    if (signal?.aborted) throw createAbortError();
    if (error instanceof AuthError && !/claude auth login/i.test(error.message)) {
      throw new AuthError(`${error.message} Run \`claude auth login\` and try again. If Claude works interactively but Exocortex still gets 401s, generate a scripted token with \`claude setup-token\` and set \`CLAUDE_CODE_OAUTH_TOKEN\` in Exocortex's secrets env.`);
    }
    if (error instanceof Error && /auth/i.test(error.message) && !/claude auth login/i.test(error.message)) {
      throw new AuthError(`${error.message} Run \`claude auth login\` and try again. If Claude works interactively but Exocortex still gets 401s, generate a scripted token with \`claude setup-token\` and set \`CLAUDE_CODE_OAUTH_TOKEN\` in Exocortex's secrets env.`);
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      runtime.close();
    } catch {
      // best-effort
    }
  }
}
