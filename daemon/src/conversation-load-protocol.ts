import type { Conversation, StoredMessage } from "./messages";
import type { PersistedUnwindReceipt } from "./json-persistence";

export interface ConversationLoadResult {
  conversation: Conversation;
  generation: number;
  receipt: PersistedUnwindReceipt | null;
  archivedTitleContext?: string[];
  validatedActiveContext?: boolean;
  window?: {
    handle: string;
    conversationId: string;
    prefixHash: string;
    path: string;
    archivedBytes: number;
    prefixSequence: number;
    prefixHistoryCount: number;
    hashAnchor?: import("./checkpoint-tail-integrity").CheckpointHashAnchor;
    sparse?: import("./conversation-window").ArchiveWindow["sparse"];
  };
  hashes: Array<[number, string]>;
  loadDiagnostics?: { cacheHit: boolean; archiveRowsRead: number; archivedBodiesRead?: number; archivedHeadersRead?: number };
  readRevision?: string;
}

export type ConversationLoadRequest =
  | { type: "load"; requestId: number; id: string; full: boolean; path: string }
  | { type: "prefetch"; requestId: number; id: string; path: string }
  | { type: "tools"; requestId: number; id: string; toolCallIds?: readonly string[]; path: string }
  | { type: "hash"; requestId: number; window: NonNullable<ConversationLoadResult["window"]>; path: string; tail: StoredMessage[] }
  | { type: "release"; handle: string };

export type ConversationLoadResponse =
  | { requestId: number; result: ConversationLoadResult | null; hashes?: never; error?: never }
  | { requestId: number; hashes: Array<[number, string]>; result?: never; error?: never }
  | { requestId: number; error: string; result?: never; hashes?: never; warmed?: never }
  | { requestId: number; outputs: import("./protocol").ToolOutputInfo[] | null; result?: never; hashes?: never; error?: never }
  | { requestId: number; warmed: boolean; result?: never; hashes?: never; error?: never };
