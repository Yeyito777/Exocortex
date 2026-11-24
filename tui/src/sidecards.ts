/**
 * The right-hand column's cards (Tasks, Subscriptions, Scratchpad), top to
 * bottom, and which of them each conversation keeps folded to its header row
 * (Shift+click on the header toggles it). Folds are per conversation and
 * persist with the rest of a route's view (startingstate.ts), like scroll
 * positions.
 */

import type { RenderState } from "./state";

export type SideCard = "tasks" | "subscriptions" | "scratchpad";

export const SIDE_CARDS: readonly SideCard[] = ["tasks", "subscriptions", "scratchpad"];

/** Folded cards by conversation id, as saved: only conversations with a folded card appear. */
export type SerializedFoldedCards = Record<string, SideCard[]>;

function isSideCard(value: unknown): value is SideCard {
  return typeof value === "string" && (SIDE_CARDS as readonly string[]).includes(value);
}

export function isCardFolded(state: RenderState, card: SideCard): boolean {
  return state.convId !== null && (state.foldedCards.get(state.convId)?.has(card) ?? false);
}

/** Fold the focused conversation's card to its header, or unfold it; a folded card is never expanded. */
export function toggleCardFold(state: RenderState, card: SideCard): void {
  const convId = state.convId;
  if (!convId) return;
  const folded = state.foldedCards.get(convId) ?? new Set<SideCard>();
  if (folded.has(card)) folded.delete(card);
  else {
    folded.add(card);
    if (card === "tasks") state.taskPanelExpansion = null;
    if (card === "subscriptions") state.subscriptionsExpansion = null;
    if (card === "scratchpad") state.scratchpadExpansion = null;
  }
  if (folded.size > 0) state.foldedCards.set(convId, folded);
  else state.foldedCards.delete(convId);
}

/** At most one card is expanded: expanding `card` collapses the others. */
export function collapseOtherExpansions(state: RenderState, card: SideCard): void {
  if (card !== "tasks") state.taskPanelExpansion = null;
  if (card !== "subscriptions") state.subscriptionsExpansion = null;
  if (card !== "scratchpad") state.scratchpadExpansion = null;
}

/** Drop folds of conversations the daemon no longer has. */
export function pruneFoldedCards(state: RenderState, validConversationIds: Iterable<string>): void {
  const valid = new Set(validConversationIds);
  for (const convId of state.foldedCards.keys()) {
    if (!valid.has(convId)) state.foldedCards.delete(convId);
  }
}

export function captureFoldedCards(state: RenderState): SerializedFoldedCards {
  return Object.fromEntries([...state.foldedCards]
    .filter(([, cards]) => cards.size > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([convId, cards]) => [convId, SIDE_CARDS.filter(card => cards.has(card))]));
}

export function applyFoldedCards(state: RenderState, folded: SerializedFoldedCards): void {
  state.foldedCards = new Map(Object.entries(folded).map(([convId, cards]) => [convId, new Set(cards)]));
}

/** Older files have none; a malformed entry only loses that conversation's folds. */
export function parseFoldedCards(value: unknown): SerializedFoldedCards {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const parsed: SerializedFoldedCards = {};
  for (const [convId, cards] of Object.entries(value)) {
    if (!convId || !Array.isArray(cards)) continue;
    const valid = SIDE_CARDS.filter(card => cards.some(entry => isSideCard(entry) && entry === card));
    if (valid.length > 0) parsed[convId] = valid;
  }
  return parsed;
}
