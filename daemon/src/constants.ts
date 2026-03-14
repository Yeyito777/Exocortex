/**
 * Shared constants for exocortexd.
 *
 * Values used across multiple daemon modules live here to avoid
 * duplication and prevent circular imports.
 */

export { MAX_CONTEXT } from "@exocortex/shared/messages";

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/** Target context size after cleanup — pressure hints tell the AI to free tokens until it reaches this. */
export const CONTEXT_TARGET = 100_000;

/**
 * After this many seconds a bash tool call is "backgrounded": the process
 * keeps running but the tool result is returned immediately with the PID
 * and a temp file path so the AI can check on it later.
 */
export const TOOL_BACKGROUND_SECONDS = Number(process.env.TOOL_BACKGROUND_SECONDS) || 60;
