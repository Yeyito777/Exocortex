/**
 * Longest sleep or wait Claude Code runs inside one chrono call. It calls chrono
 * over MCP inside its own agent loop, which Exocortex cannot suspend, so the
 * call stays open instead. Bounded by the host tool timeout, which must stay
 * within a 32-bit timer.
 */
export const CLAUDE_CODE_INLINE_CHRONO_MAX_MS = 24 * 24 * 60 * 60_000;
