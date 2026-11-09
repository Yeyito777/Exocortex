import type { RenderState } from "../state";
import { rememberCurrentConversationScroll } from "./position";
import type { ConversationScrollPosition } from "./types";

export type SerializedConversationScrollPositions = Record<string, ConversationScrollPosition>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseConversationScrollPositions(
  value: unknown,
): SerializedConversationScrollPositions | null {
  if (!isRecord(value)) return null;
  const parsed: SerializedConversationScrollPositions = {};
  for (const [convId, position] of Object.entries(value)) {
    if (!convId) return null;
    if (typeof position === "number") {
      if (!Number.isFinite(position) || position < 0 || position > 1) return null;
      parsed[convId] = position;
    } else if (isRecord(position) && Number.isSafeInteger(position.userIndex)
      && (position.userIndex as number) >= 0 && Number.isSafeInteger(position.rowOffset)) {
      parsed[convId] = { userIndex: position.userIndex as number, rowOffset: position.rowOffset as number };
    } else {
      return null;
    }
  }
  return parsed;
}

export function captureConversationScrollPositions(
  state: RenderState,
): SerializedConversationScrollPositions {
  rememberCurrentConversationScroll(state);
  return Object.fromEntries([...state.conversationScroll.positions.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function applyConversationScrollPositions(
  state: RenderState,
  positions: SerializedConversationScrollPositions,
): void {
  state.conversationScroll.positions = new Map(Object.entries(positions));
}
