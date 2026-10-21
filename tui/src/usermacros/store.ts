/**
 * The TUI's copy of the daemon's user macros, with this TUI's changes laid
 * over it so a save or delete takes effect at once, even over a slow /ssh
 * link (the pattern of ../instructions/store, simpler because each change
 * replaces or removes one whole macro).
 *
 * - `confirmed` is the daemon's list as last heard; what the TUI uses is that
 *   list with every unconfirmed change applied in order.
 * - A change is sent at once while the TUI knows the daemon's list on this
 *   connection; otherwise it waits for the next list and is checked against it.
 * - A change sent just before the link dropped may or may not have landed.
 *   The list sent after reconnecting decides: already there means it landed,
 *   otherwise it is sent again if it still makes sense, or fails.
 * - A failure (the daemon's refusal or a conflict) drops the change, so the
 *   macros roll back, and is returned for a notice.
 */
import type { UserMacro } from "@exocortex/shared/user-macros";

export type UserMacroChange =
  | { kind: "save"; macro: UserMacro; create: boolean }
  | { kind: "delete"; name: string };

export interface PendingUserMacroChange {
  change: UserMacroChange;
  /** How it was asked for, for notices. */
  label: "save" | "delete" | "restore";
  /** The /macro prompt to give back if it fails. */
  retryText?: string;
  /** Set once sent; null while it waits for the daemon's list. */
  reqId: string | null;
  /** It was sent, then the link dropped before an answer. */
  uncertain: boolean;
}

export interface UserMacroFailure {
  pending: PendingUserMacroChange;
  message: string;
}

export interface UserMacroStore {
  /** The daemon's list as last heard. */
  confirmed: UserMacro[];
  /** Heard on the current connection, so changes can be sent at once. */
  fresh: boolean;
  /** Unconfirmed changes in order. */
  pending: PendingUserMacroChange[];
}

export interface UserMacroStoreDaemon {
  readonly connected?: boolean;
  /** Returns the request id the answer will carry, or null if it was not sent. */
  saveUserMacro(macro: UserMacro, create: boolean): string | null;
  deleteUserMacro(name: string): string | null;
}

export function createUserMacroStore(): UserMacroStore {
  return { confirmed: [], fresh: false, pending: [] };
}

function applyChange(macros: readonly UserMacro[], change: UserMacroChange): UserMacro[] {
  if (change.kind === "delete") return macros.filter(macro => macro.name !== change.name);
  const next = macros.filter(macro => macro.name !== change.macro.name);
  next.push(change.macro);
  return next.sort((a, b) => a.name.localeCompare(b.name));
}

/** The macros as the TUI uses them: the daemon's list with this TUI's changes applied. */
export function shownUserMacros(store: UserMacroStore): UserMacro[] {
  return store.pending.reduce<UserMacro[]>((macros, pending) => applyChange(macros, pending.change), store.confirmed);
}

function sameMacro(a: UserMacro | undefined, b: UserMacro): boolean {
  return a !== undefined && a.name === b.name && a.expansion === b.expansion && (a.description ?? "") === (b.description ?? "");
}

function send(daemon: UserMacroStoreDaemon, change: UserMacroChange): string | null {
  return change.kind === "save" ? daemon.saveUserMacro(change.macro, change.create) : daemon.deleteUserMacro(change.name);
}

/** Apply a change now and send it, or keep it until the daemon's list is known. */
export function submitUserMacroChange(
  store: UserMacroStore,
  daemon: UserMacroStoreDaemon,
  pending: Omit<PendingUserMacroChange, "reqId" | "uncertain">,
): void {
  const entry: PendingUserMacroChange = { ...pending, reqId: null, uncertain: false };
  const waiting = store.pending.some(other => other.reqId === null);
  store.pending.push(entry);
  if (store.fresh && !waiting && daemon.connected !== false) entry.reqId = send(daemon, entry.change);
}

/** Whether a waiting change already happened, given the daemon's list. */
function landed(change: UserMacroChange, macros: readonly UserMacro[]): boolean {
  if (change.kind === "delete") return !macros.some(macro => macro.name === change.name);
  return sameMacro(macros.find(macro => macro.name === change.macro.name), change.macro);
}

/** Why a waiting change can no longer be sent as asked, or null. */
function conflict(change: UserMacroChange, macros: readonly UserMacro[]): string | null {
  if (change.kind === "save" && change.create && macros.some(macro => macro.name === change.macro.name)) {
    return `${change.macro.name} was added elsewhere meanwhile`;
  }
  return null;
}

/** The daemon's list arrived: settle, send or fail the changes waiting for it. */
function settleWaiting(store: UserMacroStore, daemon: UserMacroStoreDaemon, failures: UserMacroFailure[]): void {
  if (store.pending.some(pending => pending.reqId !== null) || daemon.connected === false) return;
  // Check each waiting change against the list as the ones before it leave it.
  let macros: UserMacro[] = store.confirmed;
  const kept: PendingUserMacroChange[] = [];
  for (const pending of store.pending) {
    // Sent before the link dropped and it got there, or it is already so.
    if (landed(pending.change, macros)) continue;
    const problem = conflict(pending.change, macros);
    if (problem) {
      failures.push({ pending, message: problem });
      continue;
    }
    kept.push(pending);
    macros = applyChange(macros, pending.change);
  }
  store.pending = kept;
  for (const pending of kept) {
    pending.uncertain = false;
    pending.reqId = send(daemon, pending.change);
  }
}

/**
 * A `user_macros` list from the daemon: the answer to one of our changes
 * (`reqId`), or a broadcast. Returns the changes that failed.
 */
export function receiveUserMacros(
  store: UserMacroStore,
  daemon: UserMacroStoreDaemon,
  macros: readonly UserMacro[],
  reqId?: string,
): UserMacroFailure[] {
  store.confirmed = [...macros];
  store.fresh = true;
  if (reqId) store.pending = store.pending.filter(pending => pending.reqId !== reqId);
  const failures: UserMacroFailure[] = [];
  settleWaiting(store, daemon, failures);
  return failures;
}

/** The daemon refused one of our changes; null when `reqId` is not ours. */
export function rejectUserMacroChange(store: UserMacroStore, reqId: string, message: string): UserMacroFailure | null {
  const index = store.pending.findIndex(pending => pending.reqId === reqId);
  if (index === -1) return null;
  const [pending] = store.pending.splice(index, 1);
  return { pending: pending!, message };
}

/** The link dropped: answers may be lost, so sent changes wait for the next list. */
export function userMacrosConnectionLost(store: UserMacroStore): void {
  store.fresh = false;
  for (const pending of store.pending) {
    if (pending.reqId !== null) pending.uncertain = true;
    pending.reqId = null;
  }
}

/** Now talking to another daemon: its list replaces ours; unconfirmed changes fail. */
export function resetUserMacroStore(store: UserMacroStore): UserMacroFailure[] {
  const failures = store.pending.map(pending => ({ pending, message: "not confirmed before switching daemons" }));
  store.confirmed = [];
  store.fresh = false;
  store.pending = [];
  return failures;
}
