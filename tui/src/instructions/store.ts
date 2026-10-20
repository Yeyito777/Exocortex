/**
 * The TUI's copy of every instruction scope it has seen, so /instructions
 * opens, switches scopes and saves without waiting on the daemon (one round
 * trip per action over /ssh).
 *
 * - Texts come from loads and from the daemon's update events; the picker
 *   shows them at once and asks the daemon again in the background.
 * - Saves are optimistic: the newest unconfirmed save is what the TUI shows,
 *   so a late confirmation for an older save never replaces newer text.
 * - A save is only sent once the TUI knows the daemon still has the text the
 *   edit started from: the scope was loaded or updated on this connection.
 *   Otherwise it waits for a load and is sent only if that load matches; a
 *   mismatch fails it instead of writing over the newer text.
 * - A save sent just before the link dropped may or may not have landed.
 *   After reconnecting a load decides: our text there means it landed, the
 *   old text means it is sent again, anything else fails it.
 * - A failed save keeps its text (`failed`) until an editor takes it back.
 */

import type { Event } from "../protocol";
import type { InstructionScope } from "./state";

export interface InstructionsStoreDaemon {
  readonly connected?: boolean;
  loadInstructions?(convId: string | null, folderId: string | null): string;
  setSystemInstructions?(convId: string, text: string): string | void;
  setFolderInstructions?(folderId: string, text: string): string | void;
  setGlobalInstructions?(text: string, expectedText?: string): string | void;
}

export interface InstructionsSave {
  scope: InstructionScope;
  /** The conversation or folder written; null for global. */
  id: string | null;
  /** Trimmed, as stored. */
  text: string;
  /** The text the edit started from. */
  base: string;
  /** Global :w!: no overwrite guard. */
  force: boolean;
  /** Set once sent; null while it waits to be checked against the daemon. */
  reqId: string | null;
  /** It was sent, then the link dropped before an answer. */
  uncertain: boolean;
}

export interface InstructionsFailure {
  /** The text that was not saved. */
  text: string;
  message: string;
  /** The daemon refused a Global save because the file changed. */
  conflict: boolean;
}

interface Entry {
  /** The daemon's text as last heard; null until loaded. */
  confirmed: string | null;
  /** Heard on the current connection, so later changes arrive as events. */
  fresh: boolean;
  /** Unconfirmed saves in order: sent ones first, then any still waiting. */
  saves: InstructionsSave[];
  failed: InstructionsFailure | null;
}

export interface InstructionsStore {
  entries: Map<string, Entry>;
  /** Loads in flight: the keys each will answer for. */
  loads: Map<string, string[]>;
}

/** What an event did, for the modal to show. */
export type InstructionsStoreChange =
  | { type: "text"; key: string }
  | { type: "saved"; key: string; save: InstructionsSave }
  | { type: "failed"; key: string; save: InstructionsSave; failure: InstructionsFailure };

export const GLOBAL_INSTRUCTIONS_KEY = "global";

export function instructionsKey(scope: InstructionScope, id: string | null): string | null {
  if (scope === "global") return GLOBAL_INSTRUCTIONS_KEY;
  return id ? `${scope}:${id}` : null;
}

function parseKey(key: string): { scope: InstructionScope; id: string | null } {
  if (key === GLOBAL_INSTRUCTIONS_KEY) return { scope: "global", id: null };
  const colon = key.indexOf(":");
  return { scope: key.slice(0, colon) as InstructionScope, id: key.slice(colon + 1) };
}

export function createInstructionsStore(): InstructionsStore {
  return { entries: new Map(), loads: new Map() };
}

function entryFor(store: InstructionsStore, key: string): Entry {
  let entry = store.entries.get(key);
  if (!entry) {
    entry = { confirmed: null, fresh: false, saves: [], failed: null };
    store.entries.set(key, entry);
  }
  return entry;
}

/** What the TUI shows for a scope: the newest save, else the daemon's text; null if unknown. */
export function instructionsText(store: InstructionsStore, key: string): string | null {
  const entry = store.entries.get(key);
  if (!entry) return null;
  return entry.saves.at(-1)?.text ?? entry.confirmed;
}

/** The daemon's text as last heard, ignoring saves still in flight. */
export function confirmedInstructionsText(store: InstructionsStore, key: string): string | null {
  return store.entries.get(key)?.confirmed ?? null;
}

export function instructionsFailure(store: InstructionsStore, key: string): InstructionsFailure | null {
  return store.entries.get(key)?.failed ?? null;
}

/** Hand a failed save's text to an editor; the store forgets it. */
export function takeInstructionsFailure(store: InstructionsStore, key: string): InstructionsFailure | null {
  const entry = store.entries.get(key);
  const failed = entry?.failed ?? null;
  if (entry) entry.failed = null;
  return failed;
}

export function hasPendingInstructionsSave(store: InstructionsStore, key: string): boolean {
  return (store.entries.get(key)?.saves.length ?? 0) > 0;
}

/** Ask the daemon for a conversation's, a folder's and the global text. */
export function loadInstructionsInto(
  store: InstructionsStore,
  daemon: InstructionsStoreDaemon,
  convId: string | null,
  folderId: string | null,
): string | null {
  if (!daemon.loadInstructions) return null;
  const reqId = daemon.loadInstructions(convId, folderId);
  const keys = [GLOBAL_INSTRUCTIONS_KEY];
  if (convId) keys.push(instructionsKey("conversation", convId)!);
  if (folderId) keys.push(instructionsKey("folder", folderId)!);
  store.loads.set(reqId, keys);
  return reqId;
}

function loadInFlight(store: InstructionsStore, key: string): boolean {
  for (const keys of store.loads.values()) if (keys.includes(key)) return true;
  return false;
}

function loadKey(store: InstructionsStore, daemon: InstructionsStoreDaemon, key: string): void {
  if (loadInFlight(store, key) || daemon.connected === false) return;
  const { scope, id } = parseKey(key);
  loadInstructionsInto(store, daemon, scope === "conversation" ? id : null, scope === "folder" ? id : null);
}

function send(daemon: InstructionsStoreDaemon, save: InstructionsSave): string | null {
  let reqId: string | void | undefined;
  switch (save.scope) {
    case "conversation":
      reqId = daemon.setSystemInstructions?.(save.id!, save.text);
      break;
    case "folder":
      reqId = daemon.setFolderInstructions?.(save.id!, save.text);
      break;
    case "global":
      // Refused if config/system.md changed since the edit began, unless forced (:w!).
      reqId = daemon.setGlobalInstructions?.(save.text, save.force ? undefined : save.base);
      break;
  }
  return typeof reqId === "string" ? reqId : null;
}

/**
 * Save a scope's text. It shows at once; the daemon write follows, now or
 * once the base text is confirmed.
 */
export function saveInstructions(
  store: InstructionsStore,
  daemon: InstructionsStoreDaemon,
  scope: InstructionScope,
  id: string | null,
  text: string,
  base: string,
  force = false,
): void {
  const key = instructionsKey(scope, id);
  if (!key) return;
  const entry = entryFor(store, key);
  const save: InstructionsSave = { scope, id, text, base, force, reqId: null, uncertain: false };
  const waiting = entry.saves.some(pending => pending.reqId === null);
  entry.saves.push(save);
  entry.failed = null;
  if (entry.fresh && !waiting && daemon.connected !== false) {
    save.reqId = send(daemon, save);
    // A transport without request ids cannot confirm: treat it as written.
    if (save.reqId === null) {
      entry.saves.pop();
      entry.confirmed = text;
    }
    return;
  }
  loadKey(store, daemon, key);
}

function failWaiting(entry: Entry, key: string, message: string, changes: InstructionsStoreChange[]): void {
  const waiting = entry.saves.filter(save => save.reqId === null);
  if (!waiting.length) return;
  entry.saves = entry.saves.filter(save => save.reqId !== null);
  const last = waiting.at(-1)!;
  entry.failed = { text: last.text, message, conflict: false };
  changes.push({ type: "failed", key, save: last, failure: entry.failed });
}

/** Send, settle or fail the saves waiting on this scope's daemon text. */
function settleWaiting(daemon: InstructionsStoreDaemon, key: string, entry: Entry, changes: InstructionsStoreChange[]): void {
  if (!entry.saves.length || entry.saves.some(save => save.reqId !== null) || daemon.connected === false) return;
  // Saves sent before the link dropped land in order: the newest one whose
  // text the daemon has landed, and every one before it.
  let landed = -1;
  entry.saves.forEach((save, index) => {
    if (save.uncertain && save.text === entry.confirmed) landed = index;
  });
  for (const save of entry.saves.splice(0, landed + 1)) changes.push({ type: "saved", key, save });

  // The rest are sent only while each starts from the text the one before leaves.
  let expected = entry.confirmed;
  let checked = 0;
  for (const save of entry.saves) {
    if (save.base !== expected) break;
    expected = save.text;
    checked++;
  }
  const rejected = entry.saves.slice(checked);
  entry.saves = entry.saves.slice(0, checked);
  for (const save of entry.saves) {
    save.uncertain = false;
    save.reqId = send(daemon, save);
  }
  const unconfirmable = entry.saves.filter(save => save.reqId === null);
  if (unconfirmable.length) {
    entry.confirmed = unconfirmable.at(-1)!.text;
    entry.saves = entry.saves.filter(save => save.reqId !== null);
  }
  if (rejected.length) {
    const last = rejected.at(-1)!;
    entry.failed = {
      text: last.text,
      message: rejected[0].uncertain ? "The link dropped and the text changed elsewhere meanwhile" : "Changed elsewhere meanwhile",
      conflict: false,
    };
    changes.push({ type: "failed", key, save: last, failure: entry.failed });
  }
}

/** The daemon's text for a scope arrived (a load, or an update from anywhere). */
function observe(store: InstructionsStore, daemon: InstructionsStoreDaemon, key: string, text: string, changes: InstructionsStoreChange[]): void {
  const entry = entryFor(store, key);
  entry.confirmed = text;
  entry.fresh = true;
  // A save that looked lost had landed after all.
  if (entry.failed && entry.failed.text === text) entry.failed = null;
  changes.push({ type: "text", key });
  settleWaiting(daemon, key, entry, changes);
}

function findSave(store: InstructionsStore, reqId: string): { key: string; entry: Entry; index: number } | null {
  for (const [key, entry] of store.entries) {
    const index = entry.saves.findIndex(save => save.reqId === reqId);
    if (index !== -1) return { key, entry, index };
  }
  return null;
}

function confirmSave(store: InstructionsStore, daemon: InstructionsStoreDaemon, reqId: string, text: string | null, changes: InstructionsStoreChange[]): boolean {
  const found = findSave(store, reqId);
  if (!found) return false;
  const { key, entry, index } = found;
  const [save] = entry.saves.splice(index, 1);
  entry.confirmed = text ?? save.text;
  entry.fresh = true;
  changes.push({ type: "saved", key, save });
  settleWaiting(daemon, key, entry, changes);
  return true;
}

function failSave(store: InstructionsStore, reqId: string, message: string, changes: InstructionsStoreChange[]): boolean {
  const found = findSave(store, reqId);
  if (!found) return false;
  const { key, entry, index } = found;
  const [save] = entry.saves.splice(index, 1);
  // A newer save is still on its way: its own answer decides what to show.
  if (entry.saves.length) return true;
  const conflict = save.scope === "global" && /changed since/i.test(message);
  entry.failed = { text: save.text, message: conflict ? "Changed elsewhere since you opened them" : message, conflict };
  changes.push({ type: "failed", key, save, failure: entry.failed });
  return true;
}

/**
 * Apply a daemon event. Returns what changed, and whether the event was the
 * answer to one of the store's own requests.
 */
export function applyInstructionsStoreEvent(
  store: InstructionsStore,
  daemon: InstructionsStoreDaemon,
  event: Event,
): { changes: InstructionsStoreChange[]; consumed: boolean } {
  const changes: InstructionsStoreChange[] = [];
  const reqId = "reqId" in event && typeof event.reqId === "string" ? event.reqId : undefined;
  let consumed = false;
  switch (event.type) {
    case "instructions_loaded":
      if (reqId) store.loads.delete(reqId);
      if (event.convId && event.conversation !== null) observe(store, daemon, instructionsKey("conversation", event.convId)!, event.conversation, changes);
      if (event.folderId && event.folder !== null) observe(store, daemon, instructionsKey("folder", event.folderId)!, event.folder, changes);
      observe(store, daemon, GLOBAL_INSTRUCTIONS_KEY, event.global, changes);
      consumed = true;
      break;
    case "folder_instructions_loaded":
      observe(store, daemon, instructionsKey("folder", event.folderId)!, event.text, changes);
      break;
    case "system_instructions_updated":
      // Our own save's broadcast; its ack settles the save.
      observe(store, daemon, instructionsKey("conversation", event.convId)!, event.text, changes);
      break;
    case "folder_instructions_updated":
      if (!(reqId && confirmSave(store, daemon, reqId, event.text, changes))) {
        observe(store, daemon, instructionsKey("folder", event.folderId)!, event.text, changes);
      }
      break;
    case "global_instructions_updated":
      if (!(reqId && confirmSave(store, daemon, reqId, event.text, changes))) {
        observe(store, daemon, GLOBAL_INSTRUCTIONS_KEY, event.text, changes);
      }
      consumed = true;
      break;
    case "ack":
      if (reqId) consumed = confirmSave(store, daemon, reqId, null, changes);
      break;
    case "error": {
      if (!reqId) break;
      if (failSave(store, reqId, event.message, changes)) {
        consumed = true;
        break;
      }
      const keys = store.loads.get(reqId);
      if (keys) {
        store.loads.delete(reqId);
        // Saves waiting on this load cannot be checked.
        for (const key of keys) {
          const entry = store.entries.get(key);
          if (entry && !entry.fresh) failWaiting(entry, key, event.message, changes);
        }
        consumed = true;
      }
      break;
    }
  }
  return { changes, consumed };
}

/**
 * The link dropped: updates may be missed from now on, and saves sent but not
 * answered may or may not have landed. They wait for a check after reconnecting.
 */
export function instructionsConnectionLost(store: InstructionsStore): void {
  store.loads.clear();
  for (const entry of store.entries.values()) {
    entry.fresh = false;
    for (const save of entry.saves) {
      if (save.reqId !== null) save.uncertain = true;
      save.reqId = null;
    }
  }
}

/** Connected again: check every scope with saves waiting. */
export function instructionsReconnected(store: InstructionsStore, daemon: InstructionsStoreDaemon): void {
  for (const [key, entry] of store.entries) {
    if (entry.saves.length) loadKey(store, daemon, key);
  }
}

/**
 * Now talking to another daemon: nothing known applies. Saves not yet
 * confirmed fail, keeping their text, and are returned for a notice.
 */
export function resetInstructionsStore(store: InstructionsStore): InstructionsStoreChange[] {
  const changes: InstructionsStoreChange[] = [];
  store.loads.clear();
  for (const [key, entry] of store.entries) {
    entry.confirmed = null;
    entry.fresh = false;
    const last = entry.saves.at(-1);
    entry.saves = [];
    if (last) {
      entry.failed = { text: last.text, message: "Not confirmed before switching daemons", conflict: false };
      changes.push({ type: "failed", key, save: last, failure: entry.failed });
    }
    if (!entry.failed) store.entries.delete(key);
  }
  return changes;
}

/** Fetch whatever /instructions would need for this conversation or draft and does not have yet. */
export function prefetchInstructions(store: InstructionsStore, daemon: InstructionsStoreDaemon, convId: string | null, folderId: string | null): void {
  if (daemon.connected === false) return;
  const missing = (key: string | null) => key !== null && store.entries.get(key)?.confirmed == null && !loadInFlight(store, key);
  const conversation = missing(instructionsKey("conversation", convId));
  const folder = missing(instructionsKey("folder", folderId));
  if (!conversation && !folder && !missing(GLOBAL_INSTRUCTIONS_KEY)) return;
  loadInstructionsInto(store, daemon, conversation ? convId : null, folderId);
}
