import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { connect, type Socket } from "net";
import { DaemonServer } from "./server";
import { createHandler } from "./handler";
import { create, flush, get, markDirty, remove } from "./conversations";
import { createStoredUserMessage } from "./messages";
import { DaemonClient } from "../../tui/src/client";
import { createInitialState, type RenderState } from "../../tui/src/state";
import { handleEvent } from "../../tui/src/events";
import { handleFocusedKey } from "../../tui/src/focus";
import { confirmEditMessage } from "../../tui/src/editmessage";

const CONV_IDS: string[] = [];

function mkConvId(suffix: string): string {
  const id = `editmessage-e2e-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  CONV_IDS.push(id);
  return id;
}

function assistantText(state: RenderState): string {
  return state.messages
    .flatMap((msg) => msg.role === "assistant" ? msg.blocks : [])
    .filter((block) => block.type === "text" || block.type === "thinking")
    .map((block) => block.text)
    .join("\n");
}

function userText(state: RenderState): string {
  return state.messages
    .filter((msg) => msg.role === "user")
    .map((msg) => msg.text)
    .join("\n");
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

afterEach(() => {
  for (const id of CONV_IDS.splice(0)) {
    remove(id);
  }
});

describe("edit-message integration", () => {
  test("Ctrl+W edit unwinds canonical history for the editor and other subscribers", async () => {
    const socketDir = mkdtempSync(join(tmpdir(), "exocortex-editmessage-e2e-"));
    const socketPath = join(socketDir, "daemon.sock");

    let commandHandler: ReturnType<typeof createHandler> | null = null;
    const server = new DaemonServer(socketPath, (client, cmd) => commandHandler?.(client, cmd));
    commandHandler = createHandler(server);
    await server.start();

    const convId = mkConvId("unwind");
    create(convId, "openai", "gpt-5.5");
    const conv = get(convId)!;
    conv.messages.push(
      createStoredUserMessage("first prompt", conv.model, 100),
      { role: "assistant", content: "first answer", metadata: null },
      createStoredUserMessage("second prompt", conv.model, 200),
      { role: "assistant", content: "second answer should disappear", metadata: null },
    );
    markDirty(convId);
    flush(convId);

    const stateA = createInitialState();
    const stateB = createInitialState();
    const stateC = createInitialState();
    const seenA: string[] = [];
    const seenB: string[] = [];
    const seenC: string[] = [];
    const clientA = new DaemonClient((event) => {
      seenA.push(event.type);
      handleEvent(event, stateA, clientA);
    }, socketPath);
    const clientB = new DaemonClient((event) => {
      seenB.push(event.type);
      handleEvent(event, stateB, clientB);
    }, socketPath);
    const clientC = new DaemonClient((event) => {
      seenC.push(event.type);
      handleEvent(event, stateC, clientC);
    }, socketPath);
    const legacyEvents: Array<{ type: string; reqId?: string }> = [];
    let legacySocket: Socket | null = null;

    try {
      await clientA.connect();
      await clientB.connect();
      await clientC.connect();
      legacySocket = connect(socketPath);
      await new Promise<void>((resolve, reject) => {
        legacySocket!.once("connect", resolve);
        legacySocket!.once("error", reject);
      });
      let legacyBuffer = "";
      legacySocket.on("data", (chunk) => {
        legacyBuffer += chunk.toString("utf8");
        let newline: number;
        while ((newline = legacyBuffer.indexOf("\n")) >= 0) {
          const line = legacyBuffer.slice(0, newline);
          legacyBuffer = legacyBuffer.slice(newline + 1);
          if (line) legacyEvents.push(JSON.parse(line));
        }
      });
      legacySocket.write(`${JSON.stringify({ type: "load_conversation", convId })}\n`);
      clientA.loadConversation(convId);
      clientB.loadConversation(convId);
      await waitFor(
        () => userText(stateA).includes("second prompt")
          && userText(stateB).includes("second prompt")
          && legacyEvents.some((event) => event.type === "conversation_loaded"),
        "all clients to load the full conversation",
      );
      seenA.length = 0;
      seenB.length = 0;
      seenC.length = 0;
      legacyEvents.length = 0;

      expect(handleFocusedKey({ type: "ctrl-w" }, stateA)).toEqual({ type: "handled" });
      expect(stateA.editMessagePrompt?.items.map((item) => item.text)).toEqual(["first prompt", "second prompt"]);
      expect(stateA.editMessagePrompt?.selection).toBe(1);
      expect(handleFocusedKey({ type: "enter" }, stateA)).toEqual({ type: "edit_message_confirm" });
      const edit = confirmEditMessage(stateA);
      expect(edit).toMatchObject({ action: "edit_sent", text: "second prompt", userMessageIndex: 1, expectedStartedAt: 200 });
      if (edit.action === "edit_sent") {
        expect(edit.targetFingerprint).toMatch(/^(?:[0-9a-f]{24}|page-v1:[0-9a-f]{24})$/);
        clientA.unwindConversation(convId, edit.userMessageIndex, edit.expectedStartedAt, edit.targetFingerprint);
      }

      await waitFor(
        () => !userText(stateA).includes("second prompt")
          && !assistantText(stateA).includes("second answer")
          && !userText(stateB).includes("second prompt")
          && !assistantText(stateB).includes("second answer"),
        "unwind to propagate to both clients",
      );

      expect(stateA.inputBuffer).toBe("second prompt");
      expect(userText(stateA)).toBe("first prompt");
      expect(assistantText(stateA)).toBe("first answer");
      expect(userText(stateB)).toBe("first prompt");
      expect(assistantText(stateB)).toBe("first answer");
      expect(stateA.sidebar.conversations.find((summary) => summary.id === convId)?.messageCount).toBe(2);
      expect(stateB.sidebar.conversations.find((summary) => summary.id === convId)?.messageCount).toBe(2);
      expect(stateC.sidebar.conversations.find((summary) => summary.id === convId)?.messageCount).toBe(2);
      expect(seenA).toEqual(["conversation_unwound"]);
      expect(seenB).toEqual(["conversation_unwound"]);
      expect(seenC).toEqual(["conversation_unwound"]);
      expect(legacyEvents.map((event) => event.type)).toEqual([
        "conversation_updated",
        "history_updated",
      ]);

      legacyEvents.length = 0;
      legacySocket.write(`${JSON.stringify({
        type: "unwind_conversation",
        reqId: "legacy-unwind",
        convId,
        userMessageIndex: 0,
      })}\n`);
      await waitFor(
        () => legacyEvents.some((event) => event.type === "conversation_loaded" && event.reqId === "legacy-unwind"),
        "legacy initiating client to receive its correlated canonical conversation",
      );
      expect(legacyEvents.map((event) => event.type)).toEqual([
        "conversation_loaded",
        "conversation_updated",
        "history_updated",
      ]);
    } finally {
      clientA.disconnect();
      clientB.disconnect();
      clientC.disconnect();
      legacySocket?.destroy();
      await server.stop();
      rmSync(socketDir, { recursive: true, force: true });
    }
  });
});
