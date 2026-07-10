import type { DisplayEntry } from "../protocol";
import type { RenderState } from "../state";
import { resolveSystemMessageColor } from "../state";

/**
 * Map daemon display entries to TUI message objects and push them onto
 * state.messages. Used by both conversation_loaded and history_updated.
 */
export function pushDisplayEntries(state: RenderState, entries: DisplayEntry[]): void {
  for (const entry of entries) {
    switch (entry.type) {
      case "user":
        state.messages.push({
          role: "user",
          text: entry.text,
          images: entry.images,
          metadata: entry.metadata ?? null,
          ...(entry.contextCheckpoint ? { contextCheckpoint: entry.contextCheckpoint } : {}),
        });
        break;
      case "ai":
        state.messages.push({
          role: "assistant",
          blocks: entry.blocks,
          metadata: entry.metadata ?? null,
        });
        break;
      case "system":
        state.messages.push({
          role: "system",
          text: entry.text,
          color: resolveSystemMessageColor(entry.color),
          metadata: entry.metadata ?? null,
        });
        break;
      case "system_instructions":
        state.messages.push({ role: "system_instructions", text: entry.text, metadata: null });
        break;
    }
  }
}
