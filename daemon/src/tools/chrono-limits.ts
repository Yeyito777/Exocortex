/**
 * Longest sleep or wait Claude Code runs inside one chrono call. It calls chrono
 * over MCP inside its own agent loop, which Exocortex cannot suspend, so the
 * call stays open instead. Bounded by the host tool timeout, which must stay
 * within a 32-bit timer.
 */
export const CLAUDE_CODE_INLINE_CHRONO_MAX_MS = 24 * 24 * 60 * 60_000;

/**
 * Longest one host tool call (chrono, client_bash, ...) runs inside a Gemini
 * turn. The Antigravity CLI gives every MCP tool call three minutes and then
 * cancels it (progress notifications do not extend that), so a longer sleep
 * or wait returns at this point and says so, and the agent calls it again; a
 * command times out here with its output so far.
 */
export const GEMINI_TOOL_CALL_MAX_MS = 170_000;
