import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { DaemonServer } from "./server";
import { createHandler } from "./handler";
import { create, get, remove } from "./conversations";
import { clearActiveJob, initStreamingState, replaceStreamingDisplayMessages, replaceCurrentStreamingBlocks, setActiveJob } from "./streaming";
import { DaemonClient } from "../../tui/src/client";
import { createInitialState } from "../../tui/src/state";
import { handleEvent } from "../../tui/src/events";
import { buildMessageLines } from "../../tui/src/conversation";

const CONV_IDS: string[] = [];

function mkConvId(suffix: string): string {
  const id = `latejoin-e2e-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  CONV_IDS.push(id);
  return id;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

afterEach(() => {
  for (const id of CONV_IDS.splice(0)) {
    clearActiveJob(id);
    remove(id);
  }
});

describe("late-join streaming integration", () => {
  test("real daemon load + real TUI client keeps the active-turn assistant coherent on refocus", async () => {
    const socketDir = mkdtempSync(join(tmpdir(), "exocortex-latejoin-e2e-"));
    const socketPath = join(socketDir, "daemon.sock");

    let commandHandler: ReturnType<typeof createHandler> | null = null;
    const server = new DaemonServer(socketPath, (client, cmd) => commandHandler?.(client, cmd));
    commandHandler = createHandler(server);
    await server.start();

    const convId = mkConvId("round-boundary");
    create(convId, "openai", "gpt-5.4");
    const conv = get(convId)!;
    conv.messages.push({ role: "user", content: "hi", metadata: null });

    // Simulate the exact problematic window: the active turn already produced a
    // completed tool round and explanatory text, but no new tail has started yet.
    // Before the fix, late joiners loaded the completed assistant prefix in
    // `entries` and only saw the trailing live tail in `pendingAI`, which made
    // the in-progress reply look truncated until the stream finished.
    setActiveJob(convId, new AbortController(), 100);
    initStreamingState(convId);
    replaceStreamingDisplayMessages(convId, [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-1", name: "bash", input: { command: "pwd" } }],
        metadata: null,
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-1", content: "/tmp", is_error: false }],
        metadata: null,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "done with the tool round" }],
        metadata: null,
      },
    ]);
    replaceCurrentStreamingBlocks(convId, []);

    const state = createInitialState();
    const seen: string[] = [];
    let onStreamingStarted!: () => void;
    const streamingStarted = new Promise<void>((resolve) => { onStreamingStarted = resolve; });
    const client = new DaemonClient((event) => {
      seen.push(event.type);
      handleEvent(event, state, client);
      if (event.type === "streaming_started") onStreamingStarted();
    }, socketPath);

    try {
      await client.connect();
      client.loadConversation(convId);
      await streamingStarted;

      expect(seen).toEqual(["conversation_loaded", "streaming_started"]);
      expect(state.messages).toEqual([
        { role: "user", text: "hi", metadata: null },
      ]);
      expect(state.pendingAI).toMatchObject({
        role: "assistant",
        blocks: [
          { type: "tool_call", toolCallId: "call-1", toolName: "bash", summary: "pwd" },
          { type: "tool_result", toolCallId: "call-1", isError: false },
          { type: "text", text: "done with the tool round" },
        ],
        metadata: { startedAt: 100, endedAt: null, model: "gpt-5.4", tokens: 0 },
      });

      const rendered = buildMessageLines(state, 80).lines.map(stripAnsi).join("\n");
      expect(rendered).toContain("done with the tool round");
      expect(rendered).not.toContain("partial old reply");
      expect((rendered.match(/done with the tool round/g) ?? [])).toHaveLength(1);
    } finally {
      client.disconnect();
      await server.stop();
      rmSync(socketDir, { recursive: true, force: true });
    }
  });
});
