import { describe, expect, test } from "bun:test";
import type { Socket } from "node:net";
import { DaemonServer, type ConnectedClient } from "../server";

function client(providerProxyLink: boolean, written: string[]): ConnectedClient {
  return {
    id: "c", buffer: "", capabilities: new Set(), subscriptions: new Set(["conv"]), providerProxyLink,
    socket: { destroyed: false, write: (data: string) => { written.push(data); return true; } } as unknown as Socket,
  };
}

describe("/proxy link connections on the remote daemon", () => {
  test("receive only provider-proxy events and errors, never broadcasts", () => {
    const server = new DaemonServer("unused", () => {});
    const link: string[] = [];
    const tui: string[] = [];
    const linkClient = client(true, link);
    const tuiClient = client(false, tui);
    (server as unknown as { clients: Map<string, ConnectedClient> }).clients.set("a", linkClient).set("b", tuiClient);
    server.broadcast({ type: "token_stats", stats: null as never });
    server.sendToSubscribers("conv", { type: "streaming_started", convId: "conv" } as never);
    server.sendTo(linkClient, { type: "provider_proxy_end", streamId: "s" });
    server.sendTo(linkClient, { type: "error", message: "x" });
    expect(link.map(line => JSON.parse(line).type)).toEqual(["provider_proxy_end", "error"]);
    expect(tui.map(line => JSON.parse(line).type)).toEqual(["token_stats", "streaming_started"]);
  });
});
