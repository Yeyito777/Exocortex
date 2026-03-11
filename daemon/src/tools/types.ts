/**
 * Tool type definitions.
 *
 * Each tool implements this interface. The registry collects them.
 * Adding a new tool = one file that exports a Tool object.
 */

// ── Execution result ───────────────────────────────────────────────

export interface ImageData {
  mediaType: string;
  base64: string;
}

export interface ToolResult {
  output: string;
  isError: boolean;
  image?: ImageData;
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

  /** Description Claude sees in the tool list. */
  description: string;

  /** JSON Schema for the tool's input parameters. */
  inputSchema: Record<string, unknown>;

  /** Optional system prompt fragment — appended to base system prompt. */
  systemHint?: string;

  /** Display metadata sent to the TUI on connect. */
  display: {
    label: string;   // "Read", "$", "Grep", etc.
    color: string;   // hex color "#82aaff"
  };

  /** Produce a human-readable one-liner from tool input. */
  summarize(input: Record<string, unknown>): ToolSummary;

  /** Execute the tool. Signal allows cooperative cancellation on abort. */
  execute(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
}
