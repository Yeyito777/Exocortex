/**
 * App conversations' tools (docs/app-api.md).
 *
 * Built-in tools are chosen by one provider-neutral vocabulary and mapped to
 * each provider's own tools: Claude Code's built-ins and the Exocortex host
 * tools under anthropic, the Exocortex tools (Codex's primitives on OpenAI)
 * elsewhere. App tools are defined and run by the app: each call is sent to
 * the conversation's owner as app_tool_call and waits for its app_tool_result.
 */

import { APP_BUILTIN_TOOLS, APP_MAX_TOOLS, APP_OWNER_WAIT_MS, APP_TOOL_DEFAULT_TIMEOUT_MS, APP_TOOL_MAX_TIMEOUT_MS, isAppToolName, type AppToolDef } from "@exocortex/shared/app-api";
import type { Event, ProviderId, ToolCallPresentation } from "./protocol";
import type { Tool, ToolResult } from "./tools/types";
import { getConversationToolNames, getRegisteredTools } from "./tools/registry";
import { getClaudeCodeToolDisplayInfo } from "./tools/claude-code";
import { summarizeParams } from "./tools/util";
import { getAppRecord } from "./app-registry";
import { log } from "./log";
import { isToolTimeoutReason } from "./abort";

// ── Built-in vocabulary ─────────────────────────────────────────────

/** Claude Code built-ins per neutral name. */
const CLAUDE_CODE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  bash: ["Bash"],
  read: ["Read"],
  write: ["Write"],
  edit: ["Edit"],
  glob: ["Glob"],
  grep: ["Grep"],
  web_search: ["WebSearch"],
  web_fetch: ["WebFetch"],
};

/** Exocortex tools per neutral name on OpenAI (Codex's primitives). */
const OPENAI_TOOLS: Readonly<Record<string, readonly string[]>> = {
  bash: ["exec_command", "write_stdin"],
  read: ["read", "view_image"],
  write: ["apply_patch"],
  edit: ["apply_patch"],
  glob: ["glob"],
  grep: ["grep"],
  web_fetch: ["browse"],
};

/** Exocortex tools per neutral name on every other provider. */
const EXOCORTEX_TOOLS: Readonly<Record<string, readonly string[]>> = {
  bash: ["bash"],
  read: ["read"],
  write: ["write"],
  edit: ["edit"],
  glob: ["glob"],
  grep: ["grep"],
  web_fetch: ["browse"],
};

/** Exocortex's own tools, offered on every provider (over MCP under Claude Code). */
const HOST_TOOLS = ["exo", "chrono", "goal", "attach"] as const;

export interface AppBuiltinSurface {
  /** Exocortex tool names for the request surface (host tools only, under Claude Code). */
  exocortexTools: string[];
  /** Claude Code built-ins to enable; undefined keeps Claude Code's own full set ("all"). */
  claudeCodeTools?: string[];
}

/**
 * Map neutral built-in names to `provider`'s tools. Throws naming the first
 * name that is unknown or that the provider cannot offer.
 */
export function resolveAppBuiltinTools(
  builtin: readonly string[] | "all",
  provider: ProviderId,
  options: { ephemeral?: boolean } = {},
): AppBuiltinSurface {
  if (builtin === "all") {
    const names = getConversationToolNames(provider);
    if (options.ephemeral && names.includes("chrono")) {
      return { exocortexTools: names.filter(name => name !== "chrono") };
    }
    return { exocortexTools: names };
  }
  const available = new Set(getRegisteredTools().map(tool => tool.name));
  const exocortexTools: string[] = [];
  const claudeCodeTools: string[] = [];
  const add = (list: string[], names: readonly string[]) => {
    for (const name of names) if (!list.includes(name)) list.push(name);
  };
  for (const name of builtin) {
    if (!(APP_BUILTIN_TOOLS as readonly string[]).includes(name)) {
      throw new Error(`Unknown built-in tool: ${name} (known: ${APP_BUILTIN_TOOLS.join(", ")})`);
    }
    if ((HOST_TOOLS as readonly string[]).includes(name)) {
      if (name === "chrono" && options.ephemeral) {
        throw new Error("Built-in tool chrono is not available to ephemeral conversations: its schedules would outlive them");
      }
      if (!available.has(name)) throw new Error(`Built-in tool ${name} is not available on this daemon`);
      add(exocortexTools, [name]);
      continue;
    }
    if (provider === "anthropic") {
      add(claudeCodeTools, CLAUDE_CODE_TOOLS[name]!);
      continue;
    }
    const mapped = (provider === "openai" ? OPENAI_TOOLS : EXOCORTEX_TOOLS)[name];
    if (!mapped) throw new Error(`Built-in tool ${name} is not available on ${provider}`);
    for (const tool of mapped) {
      if (!available.has(tool)) throw new Error(`Built-in tool ${name} is not available on ${provider} here (${tool} is unavailable)`);
    }
    add(exocortexTools, mapped);
  }
  return provider === "anthropic" ? { exocortexTools, claudeCodeTools } : { exocortexTools };
}

// ── App tool definitions ────────────────────────────────────────────

/** Names an app tool may not take: any built-in tool's, on any provider. */
function reservedToolNames(): Set<string> {
  return new Set([
    ...APP_BUILTIN_TOOLS,
    ...getRegisteredTools().map(tool => tool.name),
    ...getClaudeCodeToolDisplayInfo().map(tool => tool.name),
    ...Object.values(CLAUDE_CODE_TOOLS).flat(),
    "TodoWrite", "Task", "Agent", "Skill", "ToolSearch", "TaskStop", "TaskOutput", "BashOutput", "KillShell",
    "AskUserQuestion", "ExitPlanMode", "EnterPlanMode", "SendMessage", "Monitor", "NotebookEdit", "MultiEdit",
    "ListMcpResourcesTool", "ReadMcpResourceTool",
  ]);
}

/** Validate an app's tool definitions; returns them normalized. Throws naming the problem. */
export function validateAppToolDefs(value: unknown): AppToolDef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("tools.app must be an array");
  if (value.length > APP_MAX_TOOLS) throw new Error(`tools.app has ${value.length} tools; at most ${APP_MAX_TOOLS}`);
  const reserved = reservedToolNames();
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const def = raw as Partial<AppToolDef> | null;
    const where = `tools.app[${index}]`;
    if (!def || typeof def !== "object") throw new Error(`${where} must be an object`);
    if (!isAppToolName(def.name)) throw new Error(`${where}.name must match ^[a-zA-Z0-9_-]{1,64}$`);
    if (reserved.has(def.name)) throw new Error(`App tool name ${def.name} is a built-in tool's name`);
    if (seen.has(def.name)) throw new Error(`App tool name ${def.name} is used twice`);
    seen.add(def.name);
    if (typeof def.description !== "string" || !def.description.trim()) throw new Error(`${where}.description must be a non-empty string`);
    const schema = def.inputSchema;
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error(`${where}.inputSchema must be a JSON Schema object`);
    if (schema.type !== undefined && schema.type !== "object") throw new Error(`${where}.inputSchema must describe an object ("type": "object")`);
    let schemaText: string;
    try { schemaText = JSON.stringify(schema); } catch { throw new Error(`${where}.inputSchema must be JSON`); }
    if (def.timeoutMs !== undefined && (!Number.isSafeInteger(def.timeoutMs) || def.timeoutMs <= 0 || def.timeoutMs > APP_TOOL_MAX_TIMEOUT_MS)) {
      throw new Error(`${where}.timeoutMs must be a positive number of milliseconds up to ${APP_TOOL_MAX_TIMEOUT_MS}`);
    }
    return {
      name: def.name,
      description: def.description,
      inputSchema: { type: "object", ...(JSON.parse(schemaText) as Record<string, unknown>) },
      ...(def.timeoutMs !== undefined ? { timeoutMs: def.timeoutMs } : {}),
    };
  });
}

/** Tool definitions in the shape the request surface sends providers. */
export function appToolSurfaceDefs(defs: readonly AppToolDef[]): { name: string; description: string; input_schema: Record<string, unknown> }[] {
  return defs.map(def => ({ name: def.name, description: def.description, input_schema: def.inputSchema }));
}

const APP_TOOL_COLOR = "#c8a0ff";

function appTool(convId: string, app: string, def: AppToolDef): Tool {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    // Calls are independent requests to the app; it decides how to serve them.
    parallelSafety: "safe",
    defaultTimeoutMs: def.timeoutMs ?? APP_TOOL_DEFAULT_TIMEOUT_MS,
    // The app tool's own timeout bounds it; the stream watchdog must not.
    watchdogExempt: true,
    display: { label: app, color: APP_TOOL_COLOR },
    summarize: input => ({ label: app, detail: summarizeParams(def.name, input, []).slice(0, 200) }),
    execute: (input, context, signal) => appToolBroker.call(convId, context?.toolCallId, def.name, input, signal),
  };
}

/** The app tool `name` of conversation `convId`, as a registry tool; undefined for every other conversation. */
export function appToolFor(convId: string | undefined, name: string): Tool | undefined {
  if (!convId) return undefined;
  const record = getAppRecord(convId);
  const def = record?.appTools.find(tool => tool.name === name);
  return record && def ? appTool(convId, record.app, def) : undefined;
}

// ── Calls ───────────────────────────────────────────────────────────

/** A connection that can own app conversations. */
export interface AppToolOwner {
  readonly id: string;
}

interface PendingCall {
  convId: string;
  callId: string;
  name: string;
  input: Record<string, unknown>;
  settle(result: ToolResult): void;
  /** The owner it was last sent to. */
  sentTo: AppToolOwner | null;
  ownerWait: ReturnType<typeof setTimeout> | null;
}

export interface AppToolBrokerDeps {
  /** The connection owning a conversation, if one is connected. */
  owner(convId: string): AppToolOwner | null;
  send(owner: AppToolOwner, event: Event): void;
  /** Override for tests. */
  ownerWaitMs?: number;
}

class AppToolBroker {
  private deps: AppToolBrokerDeps | null = null;
  private readonly pending = new Map<string, PendingCall>();
  private counter = 0;

  configure(deps: AppToolBrokerDeps | null): void {
    this.deps = deps;
  }

  private key(convId: string, callId: string): string {
    return `${convId}\u0000${callId}`;
  }

  /** Run one app tool call: resolves with the owner's answer, or an error result. */
  call(convId: string, toolCallId: string | undefined, name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const app = getAppRecord(convId)?.app ?? "The app";
    let callId = toolCallId || `app-${Date.now()}-${++this.counter}`;
    while (this.pending.has(this.key(convId, callId))) callId = `${toolCallId ?? "app"}-${++this.counter}`;
    if (signal?.aborted) return Promise.resolve(this.abortResult(signal));
    return new Promise<ToolResult>((resolve) => {
      const key = this.key(convId, callId);
      const call: PendingCall = {
        convId, callId, name, input, sentTo: null, ownerWait: null,
        settle: (result) => {
          if (!this.pending.has(key)) return;
          this.pending.delete(key);
          if (call.ownerWait) clearTimeout(call.ownerWait);
          signal?.removeEventListener("abort", onAbort);
          resolve(result);
        },
      };
      const onAbort = () => {
        if (!this.pending.has(key)) return;
        this.cancel(call, signal && isToolTimeoutReason(signal.reason) ? "timeout" : "aborted");
        call.settle(this.abortResult(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(key, call);
      if (!this.dispatch(call)) {
        // Nobody to ask yet: a client reconnecting or a restarted daemon's
        // clients re-attaching get a minute to take it.
        call.ownerWait = setTimeout(() => {
          call.ownerWait = null;
          if (call.sentTo) return;
          log("warn", `app-tools: no owner attached to ${convId} for ${name} within the wait`);
          call.settle({ output: `${app} is not connected`, isError: true });
        }, this.deps?.ownerWaitMs ?? APP_OWNER_WAIT_MS);
        call.ownerWait.unref?.();
      }
    });
  }

  private abortResult(signal: AbortSignal | undefined): ToolResult {
    // The registry replaces this with its usual interrupted/timeout message.
    return { output: isToolTimeoutReason(signal?.reason) ? "App tool timed out." : "Interrupted.", isError: true };
  }

  /** Send a call to the conversation's owner; false when none is connected. */
  private dispatch(call: PendingCall): boolean {
    const owner = this.deps?.owner(call.convId) ?? null;
    if (!owner) return false;
    if (call.ownerWait) {
      clearTimeout(call.ownerWait);
      call.ownerWait = null;
    }
    call.sentTo = owner;
    this.deps!.send(owner, { type: "app_tool_call", convId: call.convId, callId: call.callId, name: call.name, input: call.input });
    return true;
  }

  private cancel(call: PendingCall, reason: "aborted" | "timeout" | "ended"): void {
    const owner = call.sentTo && this.deps?.owner(call.convId)?.id === call.sentTo.id ? call.sentTo : this.deps?.owner(call.convId) ?? null;
    if (owner) this.deps!.send(owner, { type: "app_tool_cancel", convId: call.convId, callId: call.callId, reason });
  }

  /** An app_tool_result. Late, duplicate and unknown results are ignored. */
  resolve(convId: string, callId: string, output: unknown, isError: unknown): boolean {
    const call = this.pending.get(this.key(convId, callId));
    if (!call) return false;
    call.settle({ output: typeof output === "string" ? output : JSON.stringify(output ?? ""), isError: isError === true });
    return true;
  }

  /** A new owner attached: send it every call still unanswered. */
  ownerAttached(convId: string): number {
    let sent = 0;
    for (const call of this.pending.values()) {
      if (call.convId === convId && this.dispatch(call)) sent++;
    }
    return sent;
  }

  /** The owner went away: its unanswered calls wait for another, as when none was connected. */
  ownerDetached(convId: string): void {
    const app = getAppRecord(convId)?.app ?? "The app";
    for (const call of this.pending.values()) {
      if (call.convId !== convId) continue;
      call.sentTo = null;
      if (call.ownerWait) continue;
      call.ownerWait = setTimeout(() => {
        call.ownerWait = null;
        if (call.sentTo) return;
        call.settle({ output: `${app} is not connected`, isError: true });
      }, this.deps?.ownerWaitMs ?? APP_OWNER_WAIT_MS);
      call.ownerWait.unref?.();
    }
  }

  /** The conversation ended: every call it still waits on fails. */
  conversationEnded(convId: string): void {
    for (const call of [...this.pending.values()]) {
      if (call.convId !== convId) continue;
      this.cancel(call, "ended");
      call.settle({ output: "The conversation ended.", isError: true });
    }
  }

  pendingCount(convId?: string): number {
    let count = 0;
    for (const call of this.pending.values()) if (!convId || call.convId === convId) count++;
    return count;
  }
}

export const appToolBroker = new AppToolBroker();

/** How a call to one of conversation `convId`'s app tools is shown: under the app's name. */
export function appToolCallView(convId: string): (name: string, input: Record<string, unknown>) => { summary: string; presentation: ToolCallPresentation } | undefined {
  return (name, input) => {
    const tool = appToolFor(convId, name);
    if (!tool) return undefined;
    const { label, detail } = tool.summarize(input);
    return { summary: detail || label, presentation: { toolStyle: { name, label: tool.display.label, color: tool.display.color } } };
  };
}
