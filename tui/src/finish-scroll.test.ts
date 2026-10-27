import { describe, expect, test } from "bun:test";
import { handleEvent, type DaemonActions } from "./events";
import { render } from "./render";
import { createInitialState, type RenderState } from "./state";
import { scrollBy } from "./chat";
import type { Event } from "./protocol";
import { createGenerationThroughput } from "@exocortex/shared/generation-throughput";

// Scrolled up while the AI answers, the turn finishing must leave the rows the
// user is reading where they are; at the bottom it keeps following.

const daemon: DaemonActions = {
  subscribe() {},
  unsubscribe() {},
  sendMessage() {},
  setSystemInstructions() {},
  loadToolOutputs() {},
};

function renderSilently(state: RenderState): void {
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    render(state);
  } finally {
    process.stdout.write = origWrite as typeof process.stdout.write;
  }
}

function plain(line: string | undefined): string {
  return (line ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimEnd();
}

/** The history rows on screen, top to bottom. */
function visibleRows(state: RenderState): string[] {
  return state.layout.historyViewportRows.map(row => row ? plain(state.historyLines[row.lineIndex]) : "");
}

function answerOf(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `answer line ${String(i + 1).padStart(2, "0")}`).join("\n\n");
}

function streamingTurn(answer = answerOf(40)): RenderState {
  const state = createInitialState();
  state.cols = 80;
  state.rows = 24;
  state.sidebar.open = false;
  state.convId = "finish-scroll";
  state.messages = [
    { role: "assistant", blocks: [{ type: "text", text: Array.from({ length: 30 }, (_, i) => `older ${i + 1}`).join("\n") }], metadata: null },
    { role: "user", text: "explain it", metadata: null },
  ];
  const send = (event: object) => handleEvent({ convId: state.convId, ...event } as Event, state, daemon);
  send({
    type: "streaming_started", provider: "openai", model: "gpt-5.4", startedAt: Date.now() - 5_000,
    snapshotKind: "start", generationThroughput: createGenerationThroughput("openai", "gpt-5.4"),
  });
  send({ type: "block_start", blockType: "text" });
  send({ type: "text_chunk", text: "Let me look first." });
  send({ type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "git log -3" }, summary: "git log -3" });
  send({ type: "tool_result", toolCallId: "c1", toolName: "bash", output: "a\nb\nc", isError: false });
  send({ type: "tool_call", toolCallId: "c2", toolName: "bash", input: { command: "git diff --stat" }, summary: "git diff --stat" });
  send({ type: "tool_result", toolCallId: "c2", toolName: "bash", output: "1 file changed", isError: false });
  send({ type: "block_start", blockType: "text" });
  send({ type: "text_chunk", text: answer });
  renderSilently(state);
  return state;
}

const TAIL = "\n\nanswer end";

function turnBlocks(answer: string) {
  return [
    { type: "text", text: "Let me look first." },
    { type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "git log -3" }, summary: "git log -3" },
    { type: "tool_result", toolCallId: "c1", toolName: "bash", output: "a\nb\nc", isError: false },
    { type: "tool_call", toolCallId: "c2", toolName: "bash", input: { command: "git diff --stat" }, summary: "git diff --stat" },
    { type: "tool_result", toolCallId: "c2", toolName: "bash", output: "1 file changed", isError: false },
    { type: "text", text: answer + TAIL },
  ];
}

/**
 * The daemon's end of a tool turn: the last chunk, message_complete,
 * streaming_stopped, then the canonical history_updated. Over /ssh they may
 * reach the TUI in one read (one render) or split across frames.
 */
function finish(state: RenderState, delivery: "split" | "batched", answer = answerOf(40)): void {
  const send = (event: object) => {
    handleEvent({ convId: state.convId, ...event } as Event, state, daemon);
    if (delivery === "split") renderSilently(state);
  };
  send({ type: "text_chunk", text: TAIL });
  send({ type: "message_complete", endedAt: Date.now(), tokens: 100, blocks: turnBlocks(answer) });
  send({ type: "streaming_stopped" });
  send({
    type: "history_updated",
    entries: [
      { type: "ai", blocks: state.messages[0]!.role === "assistant" ? state.messages[0]!.blocks : [], metadata: null },
      { type: "user", text: "explain it" },
      { type: "ai", blocks: turnBlocks(answer), metadata: { startedAt: Date.now() - 5_000, endedAt: Date.now(), model: "gpt-5.4", tokens: 100 } },
    ],
    historyStartIndex: 0,
    historyStartUserIndex: 0,
    historyTotalEntries: 3,
    hasOlderHistory: false,
    contextTokens: 10,
    toolOutputsIncluded: false,
  });
  renderSilently(state);
}

describe("a turn finishing while scrolled up", () => {
  // The long answer streams held at its first row; stay there (0) or scroll
  // into the answer (negative), onto the Working row, or into older history.
  for (const delivery of ["split", "batched"] as const) for (const rows of [0, -1, -20, -50, 2, 30]) {
    test(`keeps the rows being read in place (scrolled ${rows} rows, ${delivery})`, () => {
      const state = streamingTurn();
      scrollBy(state, rows);
      renderSilently(state);
      const before = visibleRows(state);
      expect(state.scrollOffset).toBeGreaterThan(0);

      finish(state, delivery);
      expect(state.pendingAI).toBeNull();
      // Only the Working row itself leaves; whatever it sat above closes up.
      const after = visibleRows(state);
      expect(after[0]).toBe(before[0]);
      expect(after.slice(0, 8)).toEqual(before.filter(row => !row.includes("Working ·")).slice(0, 8));
    });
  }

  for (const delivery of ["split", "batched"] as const) test(`at the bottom it still follows the end (${delivery})`, () => {
    const state = streamingTurn(answerOf(3));
    expect(state.scrollOffset).toBe(0);
    finish(state, delivery, answerOf(3));
    const rows = visibleRows(state).filter(Boolean);
    expect(state.scrollOffset).toBe(0);
    expect(rows.at(-2)).toBe("  answer end");
  });
});
