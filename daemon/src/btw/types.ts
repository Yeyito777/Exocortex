import type { runAgentLoop } from "../agent";
import type { hasConfiguredCredentials } from "../auth";
import type { ProviderId } from "../messages";
import type * as persistence from "../persistence";
import type { ConnectedClient } from "../server";

export interface BtwSession {
  id: string;
  convId: string;
  provider: ProviderId;
  abort: AbortController;
  running: boolean;
  /** Non-subscribed requesters that need direct stream delivery until disconnect. */
  requesters: Map<ConnectedClient, () => void>;
}

export type BtwCloseResult = "closed" | "already_closed" | "failed";

export interface BtwSessionCallbacks {
  onHeaders(provider: ProviderId, headers: Headers): void;
  onComplete(provider: ProviderId): void;
  cannotStart?(provider: ProviderId): string | null;
}

export interface BtwSessionDependencies {
  runAgentLoop: typeof runAgentLoop;
  hasConfiguredCredentials: typeof hasConfiguredCredentials;
  loadConversationBtwState: typeof persistence.loadConversationBtwState;
  saveConversationBtwState: typeof persistence.saveConversationBtwState;
}

export type BtwPersistenceDependencies = Pick<
  BtwSessionDependencies,
  "loadConversationBtwState" | "saveConversationBtwState"
>;
