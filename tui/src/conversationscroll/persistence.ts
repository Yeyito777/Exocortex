import type { RenderState } from "../state";
import { rememberCurrentConversationScroll } from "./position";

export type SerializedConversationScrollPositions = Record<string, number>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseConversationScrollPositions(
  value: unknown,
): SerializedConversationScrollPositions | null {
  if (!isRecord(value)) return null;
  const parsed: SerializedConversationScrollPositions = {};
  for (const [convId, percentage] of Object.entries(value)) {
    if (!convId || typeof percentage !== "number" || !Number.isFinite(percentage)
      || percentage < 0 || percentage > 1) return null;
    parsed[convId] = percentage;
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
