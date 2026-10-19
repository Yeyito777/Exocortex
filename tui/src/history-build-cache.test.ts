import { describe, expect, test } from "bun:test";
import { buildMessageLines, invalidateCommittedHistoryCache, type BuildMessageLinesResult } from "./conversation";
import { createInitialState, type RenderState } from "./state";
import { createPendingAI, type Message } from "./messages";
import { theme } from "./theme";

function comparable(result: BuildMessageLinesResult) {
  const { revision: _revision, ...rest } = result;
  return rest;
}

/**
 * A from-scratch build that neither reads nor disturbs the incremental cache.
 * Cloned messages also miss the per-block caches' identity fast path.
 */
function freshBuild(state: RenderState, width: number) {
  const copy = { ...state, messages: structuredClone(state.messages), pendingAI: structuredClone(state.pendingAI) };
  return comparable(buildMessageLines(copy, width));
}

function expectIncrementalMatchesFresh(state: RenderState, width = 80, reuseArrays = true): BuildMessageLinesResult {
  const incremental = buildMessageLines(state, width, { reuseArrays });
  expect(comparable(incremental)).toEqual(freshBuild(state, width));
  return incremental;
}

function assistant(blocks: Extract<Message, { role: "assistant" }>["blocks"], startedAt = 1_000): Message {
  return { role: "assistant", blocks, metadata: { startedAt, endedAt: startedAt + 2_000, model: "gpt-6-astra", tokens: 10 } };
}

function user(text: string): Message {
  return { role: "user", text, metadata: { startedAt: 500, endedAt: 500, model: "gpt-6-astra", tokens: 0 } };
}

function conversation(): RenderState {
  const state = createInitialState();
  state.convId = "conv-cache";
  state.messages.push(
    { role: "system_instructions", text: "Be brief.", metadata: null },
    user("first question"),
    assistant([
      { type: "thinking", text: "considering" },
      { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: { command: "ls -la" }, summary: "ls -la" },
      { type: "tool_result", toolCallId: "call-1", toolName: "bash", output: "a\nb\nc", isError: false },
    ]),
    assistant([{ type: "text", text: "Here is **the** answer with a [link](https://example.com)." }], 4_000),
    user("second question that is long enough to wrap across more than one row of the bubble at this width"),
    assistant([
      { type: "tool_call", toolCallId: "call-2", toolName: "bash", input: { command: "false" }, summary: "false" },
      { type: "tool_result", toolCallId: "call-2", toolName: "bash", output: "", isError: false },
      { type: "text", text: "- one\n- two\n\n```ts\nconst x = 1;\n```" },
    ], 8_000),
  );
  return state;
}

describe("incremental committed history", () => {
  test("matches a fresh build across in-place and structural history mutations", () => {
    const state = conversation();
    expectIncrementalMatchesFresh(state);
    expectIncrementalMatchesFresh(state);

    const mutations: Array<[string, () => void]> = [
      ["append a turn", () => state.messages.push(user("third"), assistant([{ type: "text", text: "third answer" }], 12_000))],
      ["replace a middle block", () => {
        const message = state.messages[3];
        if (message.role === "assistant") message.blocks[0] = { type: "text", text: "Rewritten middle answer." };
      }],
      ["fill a tool output in place", () => {
        const message = state.messages[5];
        if (message.role === "assistant" && message.blocks[1].type === "tool_result") message.blocks[1].output = "now loaded";
      }],
      ["show tool output", () => { state.showToolOutput = true; }],
      ["replace middle metadata", () => {
        const message = state.messages[2];
        if (message.role === "assistant") message.metadata = { startedAt: 1_000, endedAt: 99_000, model: "gpt-6-astra", tokens: 99 };
      }],
      ["start streaming that continues the last assistant", () => {
        state.pendingAI = createPendingAI(20_000, state.model);
        state.pendingAI.blocks.push({ type: "text", text: "streaming" });
      }],
      ["mark a committed tool call errored from the pending turn", () => {
        state.pendingAI!.blocks.push({ type: "tool_result", toolCallId: "call-2", toolName: "bash", output: "boom", isError: true });
      }],
      ["grow the streaming text", () => {
        const block = state.pendingAI!.blocks[0];
        if (block.type === "text") block.text += " more";
      }],
      ["commit the stream", () => {
        state.messages.push(state.pendingAI!);
        state.pendingAI = null;
      }],
      ["append a terminal notice", () => state.messages.push({ role: "system", text: "✗ aborted", color: theme.error, metadata: null })],
      ["unwind the tail", () => { state.messages.splice(4); }],
      ["start loading older history", () => {
        state.historyLoadingOlder = true;
        state.historyLoadingStartedAt = Date.now();
      }],
      ["animate the loading row", () => { state.historyLoadingStartedAt! -= 80; }],
      ["prepend older history", () => {
        state.messages.splice(1, 0, user("older"), assistant([{ type: "text", text: "older answer" }], 100));
        state.historyLoadingOlder = false;
        state.historyLoadingStartedAt = null;
      }],
      ["prepend a page ending mid-segment", () => {
        state.messages.splice(1, 0, user("oldest"), assistant([{ type: "text", text: "oldest answer" }], 50));
        const joined = state.messages[3];
        if (joined.role === "assistant") joined.blocks = [{ type: "text", text: "joined lead" }, ...joined.blocks];
      }],
      ["replace the message array", () => { state.messages = [...state.messages]; }],
      ["toggle diagnostics", () => { state.showDiagnostics = !state.showDiagnostics; }],
    ];
    for (const [, mutate] of mutations) {
      mutate();
      expectIncrementalMatchesFresh(state);
      expectIncrementalMatchesFresh(state, 52);
      expectIncrementalMatchesFresh(state);
    }
  });

  test("a prepend that changes the oldest loaded segment rebuilds that whole segment", () => {
    const state = createInitialState();
    state.convId = "conv-segment";
    const first = assistant([{ type: "text", text: "part one" }], 1_000);
    const second = assistant([{ type: "text", text: "part two" }], 4_000);
    const third = assistant([{ type: "text", text: "part three" }], 7_000);
    state.messages.push(
      { role: "system_instructions", text: "Be brief.", metadata: null },
      first, second, third, user("later"), assistant([{ type: "text", text: "later answer" }], 90_000),
    );
    expectIncrementalMatchesFresh(state);

    // The page's last entry joins onto the first loaded one, changing the
    // metadata the segment's final row aggregates.
    first.metadata = { startedAt: 1_000, endedAt: 60_000, model: "gpt-6-astra", tokens: 10 };
    state.messages.splice(1, 0, user("older"), assistant([{ type: "text", text: "older answer" }], 100), user("next"));
    expectIncrementalMatchesFresh(state);
  });

  test("the older-history loading row stays a single live row in every window shape", () => {
    // Windows with no turn boundary below their first entry (one long agent
    // turn, or a page opening mid-entry) used to keep each spinner frame's row
    // and add the next one: a growing stack of frozen "Loading..." rows that
    // stayed after the page arrived.
    const shapes: Array<[string, () => Message[]]> = [
      ["inside one long assistant turn", () => [
        assistant([{ type: "text", text: "lead" }], 1_000),
        assistant([{ type: "text", text: "middle" }], 4_000),
        assistant([{ type: "text", text: "tail" }], 8_000),
      ]],
      ["assistant tail then a prompt", () => [assistant([{ type: "text", text: "tail" }], 1_000), user("next")]],
      ["ordinary turns", () => [user("q1"), assistant([{ type: "text", text: "a1" }], 1_000), user("q2")]],
      ["pinned instructions only", () => []],
    ];
    for (const [, messages] of shapes) {
      for (const instructions of [null, "", "Be brief."]) {
        for (const reuseArrays of [true, false]) {
          const state = createInitialState();
          state.convId = "conv-loading-row";
          if (instructions !== null) state.messages.push({ role: "system_instructions", text: instructions, metadata: null });
          state.messages.push(...messages());
          const loadingRows = (result: BuildMessageLinesResult) => result.lineAnchors.filter(anchor => anchor.segment === "history_loading").length;
          expectIncrementalMatchesFresh(state, 80, reuseArrays);

          state.historyLoadingOlder = true;
          state.historyLoadingStartedAt = Date.now();
          for (let frame = 0; frame < 12; frame++) {
            state.historyLoadingStartedAt -= 80;
            expect(loadingRows(expectIncrementalMatchesFresh(state, 80, reuseArrays))).toBe(1);
          }

          state.historyLoadingOlder = false;
          state.historyLoadingStartedAt = null;
          expect(loadingRows(expectIncrementalMatchesFresh(state, 80, reuseArrays))).toBe(0);
        }
      }
    }
  });

  test("a copied result survives later in-place builds", () => {
    const state = conversation();
    buildMessageLines(state, 80, { reuseArrays: true });
    const snapshot = buildMessageLines(state, 80);
    const frozen = structuredClone({ lines: snapshot.lines, cont: snapshot.wrapContinuation });

    state.messages.push(user("later"));
    state.pendingAI = createPendingAI(30_000, state.model);
    state.pendingAI.blocks.push({ type: "text", text: "live" });
    const live = buildMessageLines(state, 80, { reuseArrays: true });

    expect(live.lines).not.toBe(snapshot.lines);
    expect({ lines: snapshot.lines, cont: snapshot.wrapContinuation }).toEqual(frozen);
  });

  test("reusing arrays gives each build a new revision", () => {
    const state = conversation();
    const first = buildMessageLines(state, 80, { reuseArrays: true });
    const second = buildMessageLines(state, 80, { reuseArrays: true });
    expect(second.lines).toBe(first.lines);
    expect(second.revision).not.toBe(first.revision);
  });

  test("invalidation forces a full rebuild", () => {
    const state = conversation();
    const first = buildMessageLines(state, 80, { reuseArrays: true });
    invalidateCommittedHistoryCache(state);
    const second = buildMessageLines(state, 80, { reuseArrays: true });
    expect(second.lines).not.toBe(first.lines);
    expect(comparable(second)).toEqual(freshBuild(state, 80));
  });
});
