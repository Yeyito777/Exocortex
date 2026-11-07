/**
 * A sidebar's list version: bumped by every change to its conversations or
 * folders made in place (an edited summary, a reorder, an insert or removal).
 * Per-frame caches (the row layout, folder totals) key on the lists and this
 * version instead of reading every summary each frame. A list assigned anew is
 * a new array and needs no bump.
 *
 * With EXOCORTEX_SIDEBAR_VERSION_CHECK=1 (the test suites set it), the caches
 * still compare a full recompute on every hit and throw if the lists changed
 * without a bump, so an edit that skips editConversation/editFolder/
 * touchSidebar fails a test instead of leaving a stale sidebar.
 */
import type { ConversationSummary, FolderSummary } from "../messages";

const versions = new WeakMap<object, number>();

export const SIDEBAR_VERSION_CHECK = process.env.EXOCORTEX_SIDEBAR_VERSION_CHECK === "1";

export function sidebarListVersion(sidebar: object): number {
  return versions.get(sidebar) ?? 0;
}

/** The sidebar's lists changed in place. */
export function touchSidebar(sidebar: object): void {
  versions.set(sidebar, sidebarListVersion(sidebar) + 1);
}

export function editConversation(sidebar: object, conversation: ConversationSummary, changes: Partial<ConversationSummary>): void {
  Object.assign(conversation, changes);
  touchSidebar(sidebar);
}

export function editFolder(sidebar: object, folder: FolderSummary, changes: Partial<FolderSummary>): void {
  Object.assign(folder, changes);
  touchSidebar(sidebar);
}

/** A version-keyed cache hit that a full recompute contradicts: an in-place edit skipped the bump. */
export function assertNoUnversionedEdit(what: string, cachedInputs: readonly unknown[], freshInputs: readonly unknown[]): void {
  if (cachedInputs.length === freshInputs.length && cachedInputs.every((value, index) => value === freshInputs[index])) return;
  throw new Error(`sidebar ${what}: the lists changed in place without touchSidebar/editConversation/editFolder`);
}
