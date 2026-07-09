import type { OpenAIReasoningItem } from "./types";

const EMPTY_REASONING_SUMMARY_PLACEHOLDER = "<!-- -->";

/**
 * Extract the canonical reasoning summary sections from a completed Responses item.
 */
export function extractReasoningSummaries(item: Record<string, unknown>): string[] {
  if (!Array.isArray(item.summary)) return [];
  return item.summary
    .filter((part): part is { type?: string; text?: string } => !!part && typeof part === "object")
    .filter((part) => part.type === "summary_text")
    .map((part) => part.text ?? "")
    .filter((text) => text.length > 0);
}

/**
 * Merge live-streamed reasoning summaries with the completed payload.
 *
 * The completed payload is treated as canonical for any section it includes.
 * Streamed summaries are retained only when the final payload omits that slot.
 */
export function mergeReasoningSummaries(existing: string[], completed: string[]): string[] {
  if (completed.length === 0) return [...existing];
  const merged: string[] = [];
  const maxLen = Math.max(existing.length, completed.length);
  for (let i = 0; i < maxLen; i++) {
    const completedSummary = completed[i] ?? "";
    const existingSummary = existing[i] ?? "";
    if (completedSummary) merged.push(completedSummary);
    else if (existingSummary) merged.push(existingSummary);
  }
  return merged;
}

export function extractReasoningRawContent(item: Record<string, unknown>): string[] {
  if (!Array.isArray(item.content)) return [];
  return item.content
    .filter((part): part is { type?: string; text?: string } => !!part && typeof part === "object")
    .filter((part) => part.type === "reasoning_text" || part.type === "text")
    .map((part) => part.text ?? "")
    .filter((text) => text.length > 0);
}

/**
 * OpenAI can emit a generated bold status heading followed only by an empty
 * HTML comment when a reasoning-summary part has no prose. Treat that wire
 * placeholder as non-renderable without hiding legitimate mentions of the
 * same HTML comment in otherwise meaningful text.
 */
export function isEmptyReasoningSummaryPlaceholder(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === EMPTY_REASONING_SUMMARY_PLACEHOLDER) return true;
  if (!trimmed.startsWith("**")) return false;

  const headingEnd = trimmed.indexOf("**", 2);
  if (headingEnd <= 2) return false;
  return trimmed.slice(headingEnd + 2).trim() === EMPTY_REASONING_SUMMARY_PLACEHOLDER;
}

/** Provider reasoning data is preserved independently from its UI projection. */
export function hasPreservableReasoning(reasoning: OpenAIReasoningItem | undefined): boolean {
  if (!reasoning) return false;
  return reasoning.encryptedContent !== null
    || reasoning.summaries.some((text) => text.length > 0)
    || reasoning.rawContent?.some((text) => text.length > 0) === true;
}

export function preferredReasoningTexts(reasoning: OpenAIReasoningItem | undefined): string[] {
  if (!reasoning) return [];
  if (reasoning.rawContent?.some((text) => text.length > 0)) return reasoning.rawContent;
  return reasoning.summaries.filter((text) => !isEmptyReasoningSummaryPlaceholder(text));
}

export function hasRenderableReasoning(reasoning: OpenAIReasoningItem | undefined): boolean {
  return preferredReasoningTexts(reasoning).some((text) => text.length > 0);
}

export function finalizeReasoningItem(
  reasoning: OpenAIReasoningItem | undefined,
  blocks: Array<{ type: "thinking" | "text"; text: string; signature: string } | { type: "text"; text: string }>,
  fullThinking: { value: string },
): void {
  for (const text of preferredReasoningTexts(reasoning)) {
    if (!text) continue;
    blocks.push({ type: "thinking", text, signature: "" });
    fullThinking.value += text;
  }
}
