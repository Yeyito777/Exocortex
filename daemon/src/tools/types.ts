/**
 * Tool type definitions.
 *
 * Each tool implements this interface. The registry collects them.
 * Adding a new tool = one file that exports a Tool object.
 */

import type { ProviderId } from "../messages";

export type ToolParallelSafety = "safe" | "exclusive";
export type ToolResourceClass = "filesystem_scan";

// ── Execution context / result ─────────────────────────────────────

/**
 * Daemon-owned implementation behind the native `exo` tool.
 *
 * Keeping this as an injected capability avoids making the generic tool
 * registry import the conversation orchestrator (which itself imports the
 * registry). The daemon handler installs the runtime on every conversation
 * turn; tests and non-conversation callers may omit it.
 */
export interface ExocortexToolRuntime {
  execute(
    input: Record<string, unknown>,
    parentConversationId: string | undefined,
    signal?: AbortSignal,
    /** Remaining nesting budget for the active turn; null/undefined is a root turn. */
    subagentMaxDepth?: number | null,
  ): Promise<ToolResult>;
}

export interface ToolExecutionContext {
  /** Provider backing the active conversation, when the tool is run from one. */
  provider?: ProviderId;
  /** Conversation id, if any. Reserved for future tool policies/logging. */
  conversationId?: string;
  /** Remaining native exo nesting budget; null/undefined means a root turn. */
  subagentMaxDepth?: number | null;
  /** Model backing the active conversation, when the tool is run from one. */
  model?: string;
  /** Provider-assigned tool call id for the currently executing tool. */
  toolCallId?: string;
  /** Native current-daemon management and subagent capability. */
  exocortex?: ExocortexToolRuntime;
  /** Report the lifecycle of a detached tool process owned by this conversation. */
  setBackgroundTaskActive?: (taskId: string, active: boolean) => void;
  /** Register the currently executing tool as user-backgroundable. */
  registerBackgrounder?: (backgrounder: ActiveToolBackgrounder | null) => void;
}

export interface ImageData {
  mediaType: string;
  base64: string;
}

export interface ToolResult {
  output: string;
  isError: boolean;
  image?: ImageData;
}

export interface ActiveToolBackgrounder {
  toolName: string;
  toolCallId?: string;
  /** Return true when this call was backgrounded by this request. */
  background(): boolean;
}

// ── Display data (sent to TUI) ─────────────────────────────────────

export interface ToolSummary {
  label: string;
  detail: string;
}

// ── Tool definition ────────────────────────────────────────────────

export interface Tool {
  /** Unique name matching the API tool_use name. */
  name: string;

  /** Description the model sees in the tool list. */
  description: string;

  /** JSON Schema for the tool's input parameters. */
  inputSchema: Record<string, unknown>;

  /** Optional system prompt fragment — appended to base system prompt. */
  systemHint?: string;

  /** Optional runtime availability gate (auth, platform, env, etc.). */
  isAvailable?: () => boolean;

  /**
   * Whether this tool may run concurrently with adjacent safe tool calls.
   * Defaults to "exclusive" so new or side-effecting tools are conservative.
   */
  parallelSafety?: ToolParallelSafety;

  /**
   * Default wall-clock deadline for one invocation. `null` explicitly opts out
   * (used by bash, which has its own timeout/backgrounding lifecycle).
   * Unspecified tools receive the registry's conservative fallback deadline.
   */
  defaultTimeoutMs?: number | null;

  /** Shared resource pool used to bound expensive calls across conversations. */
  resourceClass?: ToolResourceClass;

  /**
   * Whether the conversation stale-stream watchdog should be paused while this
   * tool runs. Only independently managed long-running tools should opt in.
   */
  watchdogExempt?: boolean;

  /** Display metadata sent to the TUI on connect. */
  display: {
    label: string;   // "Read", "$", "Grep", etc.
    color: string;   // hex color "#82aaff"
  };

  /** Produce a human-readable one-liner from tool input. */
  summarize(input: Record<string, unknown>): ToolSummary;

  /** Execute the tool. Context carries conversation/provider metadata when available. */
  execute(input: Record<string, unknown>, context?: ToolExecutionContext, signal?: AbortSignal): Promise<ToolResult>;
}
