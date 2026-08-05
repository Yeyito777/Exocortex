import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { dataDir } from "@exocortex/shared/paths";
import type { ActiveContext } from "./messages";

interface QuarantineOptions {
  root?: string;
  now?: number;
  nonce?: string;
}

/**
 * Durably preserve a rejected derived checkpoint before the live pointer is
 * cleared. The canonical transcript remains authoritative, but recovery must
 * never depend on a provider checkpoint that was destructively discarded.
 */
export function quarantineActiveContext(
  conversationId: string,
  activeContext: ActiveContext,
  reason: string,
  options: QuarantineOptions = {},
): string {
  if (!/^[A-Za-z0-9_-]+$/.test(conversationId)) {
    throw new Error(`Unsafe conversation ID for active-context quarantine: ${conversationId}`);
  }
  const now = options.now ?? Date.now();
  const nonce = options.nonce ?? randomUUID();
  if (!Number.isSafeInteger(now) || now < 0 || !/^[A-Za-z0-9_-]+$/.test(nonce)) {
    throw new Error("Invalid active-context quarantine identity");
  }
  const root = resolve(options.root ?? join(dataDir(), "active-context-quarantine"));
  const directory = join(root, conversationId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { chmodSync(directory, 0o700); } catch { /* best effort on non-POSIX filesystems */ }
  const destination = join(directory, `${now}-${nonce}.json`);
  const temporary = `${destination}.tmp`;
  const payload = {
    version: 1,
    conversationId,
    quarantinedAt: now,
    reason,
    activeContext,
  };
  try {
    writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, destination);
    try { chmodSync(destination, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
    return destination;
  } finally {
    rmSync(temporary, { force: true });
  }
}
