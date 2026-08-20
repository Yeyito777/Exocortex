import { createHash } from "node:crypto";
import type { StoredMessage } from "./messages";

/** Stable full-row identity shared by normalized persistence and paged editing. */
export function storedMessageFingerprint(message: StoredMessage): string {
  return createHash("sha256").update(JSON.stringify({
    role: message.role,
    content: message.content,
    metadata: message.metadata,
    providerData: message.providerData ?? null,
    contextTokens: message.contextTokens ?? null,
    contextCheckpoint: message.contextCheckpoint ?? null,
  })).digest("hex");
}

function legacyPagedUserFingerprint(
  convId: string,
  userIndex: number,
  message: StoredMessage,
): string {
  const hash = createHash("sha256");
  hash.update(convId);
  hash.update("\n");
  hash.update(String(userIndex));
  hash.update("\n");
  hash.update(JSON.stringify({
    role: message.role,
    content: message.content,
    providerData: message.providerData ?? null,
  }));
  return `page-v1:${hash.digest("hex").slice(0, 24)}`;
}

/**
 * Opaque user identity used only to reject stale history-edit requests.
 *
 * The conversation ID and user index are already independent command parameters,
 * and modern turns also carry their start time. Binding this value to immutable
 * canonical content keeps identical cloned rows reusable without invalidating an
 * open editor when background context-token attribution changes.
 */
export function pagedUserFingerprint(
  _convId: string,
  _userIndex: number,
  message: StoredMessage,
): string {
  const contentHash = createHash("sha256").update(JSON.stringify(message.content)).digest("hex");
  return `page-v2:${contentHash.slice(0, 24)}`;
}

export function isPagedUserFingerprint(value: string): boolean {
  return /^page-v[12]:[0-9a-f]{24}$/.test(value);
}

/** Validate both existing v1 projections and newly-written v2 projections. */
export function pagedUserFingerprintMatches(
  value: string,
  convId: string,
  userIndex: number,
  message: StoredMessage,
): boolean {
  if (value.startsWith("page-v1:")) {
    return legacyPagedUserFingerprint(convId, userIndex, message) === value;
  }
  return value.startsWith("page-v2:")
    && pagedUserFingerprint(convId, userIndex, message) === value;
}
