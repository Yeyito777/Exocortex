import type { ProviderId } from "../messages";
import type { ConnectedClient } from "../server";
import type { BtwSession } from "./types";

/** Live, process-local BTW sessions and their transient delivery bookkeeping. */
export class BtwRuntime {
  private readonly sessions = new Map<string, BtwSession>();
  /** Includes abort cleanup after a panel has already been removed/replaced. */
  private readonly inFlightProviders = new Map<ProviderId, number>();

  get(convId: string): BtwSession | undefined {
    return this.sessions.get(convId);
  }

  set(convId: string, session: BtwSession): void {
    this.sessions.set(convId, session);
  }

  delete(convId: string): boolean {
    return this.sessions.delete(convId);
  }

  isCurrent(convId: string, session: BtwSession): boolean {
    return this.sessions.get(convId) === session;
  }

  hasRunningProvider(provider: ProviderId): boolean {
    return (this.inFlightProviders.get(provider) ?? 0) > 0;
  }

  beginProvider(provider: ProviderId): void {
    this.inFlightProviders.set(provider, (this.inFlightProviders.get(provider) ?? 0) + 1);
  }

  finishProvider(provider: ProviderId): void {
    const remaining = (this.inFlightProviders.get(provider) ?? 1) - 1;
    if (remaining > 0) this.inFlightProviders.set(provider, remaining);
    else this.inFlightProviders.delete(provider);
  }

  addRequester(session: BtwSession, client: ConnectedClient): void {
    if (client.subscriptions.has(session.convId) || session.requesters.has(client)) return;
    const onClose = () => session.requesters.delete(client);
    session.requesters.set(client, onClose);
    client.socket.once("close", onClose);
  }

  clearRequesters(session: BtwSession): void {
    for (const [client, onClose] of session.requesters) client.socket.off("close", onClose);
    session.requesters.clear();
  }

  requesterList(session: BtwSession | undefined, client?: ConnectedClient): ConnectedClient[] {
    return [...new Set([...(client ? [client] : []), ...(session?.requesters.keys() ?? [])])];
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      if (session.running) session.abort.abort("btw-manager-disposed");
      this.clearRequesters(session);
    }
    this.sessions.clear();
  }
}
