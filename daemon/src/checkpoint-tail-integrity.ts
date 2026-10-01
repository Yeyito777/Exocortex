import { createHash } from "node:crypto";
import type { StoredMessage } from "./messages";

export class ConversationIntegrityError extends Error {
  constructor(message: string) { super(message); this.name = "ConversationIntegrityError"; }
}

export interface CheckpointHashAnchor { historyCount: number; hash: string }

export interface ReplayHash {
  update(value: string): unknown;
  copy(): ReplayHash;
  digest(format: "hex"): string;
}

/**
 * Domain-separated per-message chain, NOT an extension of legacy stream SHA.
 * Every cursor is a resumable root. Installing a newer checkpoint therefore
 * preserves future fingerprints across restart without retaining SHA internals
 * or rereading the superseded prefix.
 */
class CheckpointTailHash implements ReplayHash {
  private pending = "";
  constructor(private count: number, private root: string) {}
  update(value: string): this {
    if (value !== "\n") { this.pending += value; return this; }
    this.root = integritySha(`exocortex:checkpoint-tail:v1\n${++this.count}\n${this.root}\n${this.pending}\n`).slice(0, 24);
    this.pending = "";
    return this;
  }
  copy(): CheckpointTailHash {
    const copy = new CheckpointTailHash(this.count, this.root);
    copy.pending = this.pending;
    return copy;
  }
  digest(_format: "hex"): string {
    if (this.pending) throw new Error("Incomplete checkpoint-tail message");
    return this.root;
  }
}

export function checkpointTailHasher(anchor: CheckpointHashAnchor): ReplayHash {
  return new CheckpointTailHash(anchor.historyCount, anchor.hash);
}
export function updateCheckpointTailHash(hash: ReplayHash, message: StoredMessage) {
  hash.update(JSON.stringify({ role: message.role, content: message.content, providerData: message.providerData ?? null }));
  hash.update("\n");
}
export function integritySha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
