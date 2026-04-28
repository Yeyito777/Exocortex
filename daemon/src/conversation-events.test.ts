import { afterEach, describe, expect, test } from "bun:test";
import { broadcastConversationUpdated } from "./conversation-events";
import { create, remove } from "./conversations";
import type { DaemonServer } from "./server";

const ids: string[] = [];

function mkId(suffix: string): string {
  const id = `test-conv-events-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  ids.push(id);
  return id;
}

function captureServer() {
  const events: unknown[] = [];
  const server = {
    broadcast(event: unknown) {
      events.push(event);
    },
  } as unknown as DaemonServer;

  return { server, events };
}

afterEach(() => {
  for (const id of ids.splice(0)) remove(id);
});

describe("broadcastConversationUpdated", () => {
  test("does not broadcast a null summary for a missing conversation", () => {
    const { server, events } = captureServer();

    expect(broadcastConversationUpdated(server, "missing-conversation")).toBe(false);

    expect(events).toEqual([]);
  });

  test("broadcasts conversation_updated when a summary exists", () => {
    const id = mkId("existing");
    create(id, "openai", "gpt-5.5");
    const { server, events } = captureServer();

    expect(broadcastConversationUpdated(server, id)).toBe(true);

    expect(events).toMatchObject([{ type: "conversation_updated", summary: { id } }]);
  });
});
