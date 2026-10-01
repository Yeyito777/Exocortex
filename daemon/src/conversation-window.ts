/**
 * Runtime-only references to a compacted archive. Never persisted.
 *
 * Workers hash real canonical bytes. The foreground holds only immutable row
 * headers before the compact boundary and real messages after it. Hash proofs
 * are bound to exact object/content references, not to caller-supplied metadata.
 * Missing or changed proofs fail closed; archive references must never be
 * serialized as canonical messages or submitted to a provider.
 */
import type { StoredMessage } from "./messages";

export interface ArchiveProofSnapshot {
  ref: StoredMessage;
  role: StoredMessage["role"];
  content: StoredMessage["content"];
  providerData: StoredMessage["providerData"];
  replay: boolean;
}

export interface ArchiveWindow {
  handle: string;
  conversationId: string;
  prefixHash: string;
  path: string;
  archivedBytes: number;
  prefixSequence: number;
  prefixHistoryCount: number;
  headers: StoredMessage[];
}

interface Proof {
  window: ArchiveWindow;
  snapshot: ArchiveProofSnapshot[];
  hashes: Map<number, string>;
}

const headers = new WeakMap<StoredMessage, { window: ArchiveWindow; sequence: number }>();
const proofs = new WeakMap<StoredMessage[], Proof>();

function snapshot(messages: StoredMessage[]): ArchiveProofSnapshot[] {
  return messages.map(ref => ({ ref, role: ref.role, content: ref.content, providerData: ref.providerData, replay: replay(ref) }));
}

function replay(message: StoredMessage): boolean {
  return message.role !== "system" && message.role !== "system_instructions" && message.metadata?.kind !== "context_warning";
}

function freezeJson(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const item of Object.values(value)) freezeJson(item);
  Object.freeze(value);
}

export function freezeArchiveCheckpoint(value: unknown): void { freezeJson(value); }

/** Canonical replay content is immutable; replacement invalidates the proof. */
export function freezeReplayContent(messages: StoredMessage[]): void {
  for (const message of messages) {
    freezeJson(message.content);
    freezeJson(message.providerData);
  }
}

function matches(messages: StoredMessage[], saved: ArchiveProofSnapshot[], through = messages.length): boolean {
  if (through > saved.length) return false;
  for (let i = 0; i < through; i++) {
    const message = messages[i], old = saved[i];
    if (!message || message !== old.ref || message.role !== old.role
        || message.content !== old.content || message.providerData !== old.providerData
        || replay(message) !== old.replay) return false;
  }
  return true;
}

export function archiveWindow(messages: StoredMessage[]): ArchiveWindow | null {
  const proof = proofs.get(messages);
  if (proof) {
    const window = proof.window;
    if (messages.length < window.prefixSequence
        || window.headers.some((header, i) => messages[i] !== header)) {
      throw new Error("Archived conversation prefix was changed");
    }
    return window;
  }
  for (let i = 0; i < messages.length; i++) {
    const header = headers.get(messages[i]);
    if (!header) continue;
    if (header.sequence !== i) throw new Error("Archived conversation prefix was reordered");
    const window = header.window;
    if (messages.length < window.prefixSequence) throw new Error("Archived conversation prefix was truncated");
    for (let j = 0; j < window.prefixSequence; j++) {
      if (messages[j] !== window.headers[j]) throw new Error("Archived conversation prefix was changed");
    }
    return window;
  }
  return null;
}

export function isArchivedMessage(message: StoredMessage): boolean {
  return headers.has(message);
}

/** Called only for a validated worker result, never for persisted JSON. */
export function adoptArchiveWindow(
  messages: StoredMessage[], window: Omit<ArchiveWindow, "headers">,
  hashes: Array<[number, string]>,
): void {
  const bound: ArchiveWindow = { ...window, headers: messages.slice(0, window.prefixSequence) };
  freezeReplayContent(messages);
  for (let i = 0; i < bound.headers.length; i++) {
    const message = bound.headers[i];
    if (Array.isArray(message.content)) {
      for (const part of message.content) Object.freeze(part);
      Object.freeze(message.content);
    }
    freezeJson(message.metadata);
    freezeJson(message.contextCheckpoint);
    headers.set(message, { window: bound, sequence: i });
    Object.freeze(message);
  }
  bindArchiveHashProof(messages, bound, hashes);
}

export function bindArchiveHashProof(
  messages: StoredMessage[], window: ArchiveWindow, hashes: Array<[number, string]>,
): void {
  if (messages.length < window.prefixSequence
      || window.headers.some((header, i) => messages[i] !== header)) {
    throw new Error("Cannot bind a hash proof to changed archive references");
  }
  const previous = proofs.get(messages);
  const combined = new Map<number, string>();
  // A restored worker prefix can prove new tail cursors without recomputing all
  // historical user boundaries. Retain only still-bound immutable old proofs.
  if (previous && matches(messages, previous.snapshot, window.prefixSequence)) {
    for (const [count, hash] of previous.hashes) if (count <= window.prefixHistoryCount) combined.set(count, hash);
  }
  for (const [count, hash] of hashes) combined.set(count, hash);
  proofs.set(messages, { window, snapshot: snapshot(messages), hashes: combined });
}

export function archiveProofSnapshot(messages: StoredMessage[]): ArchiveProofSnapshot[] {
  freezeReplayContent(messages);
  return snapshot(messages);
}

export function archiveProofSnapshotMatches(messages: StoredMessage[], saved: ArchiveProofSnapshot[]): boolean {
  return messages.length === saved.length && matches(messages, saved);
}

export function archiveHashesAreCurrent(messages: StoredMessage[]): boolean {
  const proof = proofs.get(messages);
  return !!proof && messages.length === proof.snapshot.length && matches(messages, proof.snapshot);
}

/** Carry an already validated proof to a shallow prefix/copy, never changed content. */
export function inheritArchiveHashProof(from: StoredMessage[], to: StoredMessage[]): void {
  const proof = proofs.get(from);
  if (!proof) return;
  if (!matches(from, proof.snapshot) || !matches(to, proof.snapshot)) {
    throw new Error("Cannot inherit a hash proof after transcript changes");
  }
  proofs.set(to, { window: proof.window, snapshot: proof.snapshot.slice(0, to.length), hashes: proof.hashes });
}

export function provenArchiveHashes(
  messages: StoredMessage[], counts: readonly number[],
): Map<number, string> | null {
  const window = archiveWindow(messages);
  if (!window) return null;
  const proof = proofs.get(messages);
  const maxCount = Math.max(0, ...counts);
  let through = 0, seen = 0;
  while (through < messages.length && seen < maxCount) {
    const message = messages[through++];
    if (message.role !== "system" && message.role !== "system_instructions"
        && message.metadata?.kind !== "context_warning") seen++;
  }
  if (!proof || !matches(messages, proof.snapshot, through)) {
    throw new Error("Conversation hash proof requires an off-thread refresh");
  }
  const result = new Map<number, string>();
  const historyCount = messages.reduce((count, message) => count
    + (message.role !== "system" && message.role !== "system_instructions"
      && message.metadata?.kind !== "context_warning" ? 1 : 0), 0);
  for (const count of counts) {
    if (!Number.isSafeInteger(count) || count < 0 || count > historyCount) {
      throw new Error(`Invalid archive prefix cursor ${count}/${historyCount}`);
    }
    const hash = proof.hashes.get(count);
    if (!hash) throw new Error(`Missing verified archive prefix hash at ${count}`);
    result.set(count, hash);
  }
  return result;
}

export function assertCanonicalMessage(message: StoredMessage): void {
  if (isArchivedMessage(message)) throw new Error("Refusing to persist or replay an archived row header");
}
