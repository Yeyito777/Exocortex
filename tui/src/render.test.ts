import { describe, expect, test } from "bun:test";
import { createPendingAI } from "./messages";
import { advanceDeferredHistoryRender, hasDeferredHistoryRenderWork, render, invalidateHistoryRenderCache } from "./render";
import { createInitialState, type RenderState } from "./state";
import { invalidateFrame } from "./frame";
import { theme } from "./theme";
import { termWidth } from "./textwidth";
import { hide_cursor, show_cursor } from "./terminal";

function captureRenderOutput(state: RenderState): string {
  let out = "";
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    render(state);
  } finally {
    process.stdout.write = origWrite as typeof process.stdout.write;
  }
  return out;
}

function renderSilently(state: RenderState): void {
  void captureRenderOutput(state);
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function stripCsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

function positionedWrites(output: string): Array<{ row: number; col: number; text: string }> {
  const moveRe = /\x1b\[(\d+);(\d+)H/g;
  const writes: Array<{ row: number; col: number; start: number; text: string }> = [];
  let current: { row: number; col: number; start: number; text: string } | null = null;
  for (let match = moveRe.exec(output); match !== null; match = moveRe.exec(output)) {
    if (current) {
      current.text = output.slice(current.start, match.index);
      writes.push(current);
    }
    current = { row: Number(match[1]), col: Number(match[2]), start: moveRe.lastIndex, text: "" };
  }
  if (current) {
    current.text = output.slice(current.start);
    writes.push(current);
  }
  return writes;
}

function makeState(): RenderState {
  const state = createInitialState();
  state.cols = 120;
  state.rows = 40;
  state.messages = [
    { role: "user", text: "hello", metadata: null },
    {
      role: "assistant",
      blocks: [{ type: "text", text: "# Heading\n\nSome **markdown** content that wraps across lines." }],
      metadata: null,
    },
  ];
  return state;
}

describe("render caching and frame diffing", () => {
  test("reuses cached history lines when only the prompt changes", () => {
    const state = makeState();

    renderSilently(state);
    const firstLines = state.historyLines;
    const firstBounds = state.historyMessageBounds;

    state.inputBuffer = "/help";
    state.cursorPos = state.inputBuffer.length;
    renderSilently(state);

    expect(state.historyLines).toBe(firstLines);
    expect(state.historyMessageBounds).toBe(firstBounds);
  });

  test("invalidates cached history when the older-history loading row appears", () => {
    const state = makeState();
    renderSilently(state);
    expect(state.historyLines.some((line) => stripAnsi(line).includes("Loading..."))).toBe(false);

    state.historyLoadingOlder = true;
    state.historyLoadingStartedAt = Date.now();
    renderSilently(state);

    expect(state.historyLines.some((line) => stripAnsi(line).includes("Loading..."))).toBe(true);
  });

  test("does not reuse the static history cache while streaming", () => {
    const state = makeState();
    state.pendingAI = createPendingAI(Date.now(), state.model);
    state.pendingAI.blocks.push({ type: "text", text: "partial reply" });

    renderSilently(state);
    const firstLines = state.historyLines;

    state.inputBuffer = "typed while streaming";
    state.cursorPos = state.inputBuffer.length;
    renderSilently(state);

    expect(state.historyLines).not.toBe(firstLines);
  });

  test("manual invalidation rebuilds cached history after in-place message edits", () => {
    const state = makeState();

    renderSilently(state);
    const firstLines = state.historyLines;

    const assistant = state.messages[1];
    if (assistant.role !== "assistant") throw new Error("expected assistant message");
    assistant.blocks[0] = { type: "text", text: "updated body" };
    invalidateHistoryRenderCache(state);
    renderSilently(state);

    expect(state.historyLines).not.toBe(firstLines);
    expect(stripAnsi(state.historyLines.join("\n"))).toContain("updated body");
  });

  test("prompt typing flushes only the changed bottom row instead of the whole screen", () => {
    const state = makeState();
    captureRenderOutput(state); // prime previous-frame cache

    state.inputBuffer = "typed";
    state.cursorPos = state.inputBuffer.length;
    const out = captureRenderOutput(state);

    const clearCount = (out.match(/\x1b\[2K/g) || []).length;
    const col1Rows = Array.from(out.matchAll(/\x1b\[(\d+);1H/g), (match) => Number(match[1]));

    expect(clearCount).toBe(1);
    expect(new Set(col1Rows)).toEqual(new Set([37]));
    expect(out.startsWith(`\x1b[?2026h${hide_cursor}`)).toBe(true);
    expect(out.endsWith("\x1b[?2026l")).toBe(true);
    expect(out).toContain(show_cursor);
  });

  test("unchanged frames emit no redraw bytes", () => {
    const state = makeState();
    captureRenderOutput(state); // initial full frame

    const out = captureRenderOutput(state);

    expect(out).toBe("");
  });

  test("invalidating the retained frame forces a full-row repaint", () => {
    const state = makeState();
    captureRenderOutput(state); // initial full frame
    expect(captureRenderOutput(state)).toBe(""); // unchanged frame is otherwise retained

    invalidateFrame(state);
    const out = captureRenderOutput(state);

    const clearCount = (out.match(/\x1b\[2K/g) || []).length;
    expect(clearCount).toBe(state.rows);
  });

  test("streaming viewport shifts use a scroll region instead of redrawing the full message area", () => {
    const state = createInitialState();
    state.cols = 80;
    state.rows = 20;
    state.pendingAI = createPendingAI(Date.now(), state.model);
    state.pendingAI.blocks.push({
      type: "text",
      text: ("Initial streaming text with enough words to wrap across terminal columns. ").repeat(40),
    });
    captureRenderOutput(state); // prime previous-frame cache with an overflowing viewport

    (state.pendingAI.blocks[0] as { type: "text"; text: string }).text += (
      " More streaming text appended at the bottom of the same paragraph. "
    ).repeat(3);
    const out = captureRenderOutput(state);

    const clearCount = (out.match(/\x1b\[2K/g) || []).length;
    expect(out).toMatch(/\x1b\[3;\d+r/);
    expect(clearCount).toBeLessThan(state.layout.messageAreaHeight);
  });

  test("positions focused conversation tasks at the message area's top-right", () => {
    const state = makeState();
    state.convId = "parent";
    state.toolRegistry = [
      { name: "exo", label: "Exocortex", color: "#1d9bf0" },
      { name: "bash", label: "$", color: "#d19a66" },
    ];
    state.sidebar.conversations = [{
      id: "parent",
      provider: state.provider,
      model: state.model,
      effort: state.effort,
      fastMode: state.fastMode,
      createdAt: 1,
      updatedAt: 2,
      messageCount: 2,
      title: "Parent",
      marked: false,
      pinned: false,
      streaming: false,
      unread: false,
      sortOrder: 0,
      tasks: [{ id: "child", kind: "subagent", title: "Inspect renderer flow", startedAt: Date.now() - 2_000 }],
    }];

    const writes = positionedWrites(captureRenderOutput(state));
    const header = writes.find(write => write.row === 3 && write.col === 71 && stripAnsi(write.text).includes("Tasks"));
    const task = writes.find(write => write.row === 4 && write.col === 71 && stripAnsi(write.text).includes("Inspect renderer flow"));

    expect(header).toBeDefined();
    expect(task).toBeDefined();
  });

  test("keeps macro highlighting active while voice placeholders are rendered", () => {
    const state = createInitialState();
    state.cols = 100;
    state.rows = 30;
    state.panelFocus = "chat";
    state.chatFocus = "prompt";
    state.vim.mode = "normal";
    state.inputBuffer = "/go";
    state.cursorPos = state.inputBuffer.length;
    state.voicePromptJobs = [{
      id: 1,
      phase: "transcribing",
      frameIndex: 0,
      insertionPos: 0,
      suffixText: " ",
    }];

    const out = captureRenderOutput(state);

    expect(out).toContain(theme.command + "/go" + theme.reset);
    expect(stripAnsi(out)).toContain("Transcribing… /go");
  });

  test("autocomplete popup is capped instead of covering the whole message area", () => {
    const state = createInitialState();
    state.cols = 100;
    state.rows = 40;
    state.panelFocus = "chat";
    state.chatFocus = "prompt";
    state.vim.mode = "insert";
    state.inputBuffer = "/queue ";
    state.cursorPos = state.inputBuffer.length;
    state.autocomplete = {
      type: "command",
      selection: -1,
      prefix: state.inputBuffer,
      tokenStart: 0,
      matches: Array.from({ length: 25 }, (_, i) => ({
        name: `queue-target-${String(i).padStart(2, "0")}`,
        desc: "conversation",
      })),
    };

    const plain = stripAnsi(captureRenderOutput(state));
    const renderedTargets = plain.match(/queue-target-\d\d/g) ?? [];

    expect(renderedTargets).toHaveLength(10);
    expect(renderedTargets).toContain("queue-target-00");
    expect(renderedTargets).toContain("queue-target-09");
    expect(renderedTargets).not.toContain("queue-target-10");
  });

  test("autocomplete popup dynamically sizes to visible content", () => {
    const state = createInitialState();
    state.cols = 120;
    state.rows = 30;
    state.panelFocus = "chat";
    state.chatFocus = "prompt";
    state.vim.mode = "insert";
    state.inputBuffer = "/queue ";
    state.cursorPos = state.inputBuffer.length;
    state.autocomplete = {
      type: "command",
      selection: -1,
      prefix: state.inputBuffer,
      tokenStart: 0,
      matches: [
        { name: "alpha", desc: "desc" },
        { name: "beta", desc: "desc" },
      ],
    };

    const writes = positionedWrites(captureRenderOutput(state));
    const autocompleteRows = writes
      .map(write => ({ ...write, plain: stripCsi(stripAnsi(write.text)) }))
      .filter(write => write.plain.includes("alpha") || write.plain.includes("beta"));

    expect(autocompleteRows).toHaveLength(2);
    for (const row of autocompleteRows) {
      expect(termWidth(row.plain)).toBe(12);
      expect(termWidth(row.plain)).toBeLessThan(state.cols - 2);
    }
  });

  test("autocomplete rows never exceed the chat width even with long offscreen matches", () => {
    const state = createInitialState();
    state.cols = 80;
    state.rows = 30;
    state.panelFocus = "chat";
    state.chatFocus = "prompt";
    state.vim.mode = "insert";
    state.inputBuffer = "/queue ";
    state.cursorPos = state.inputBuffer.length;
    state.autocomplete = {
      type: "command",
      selection: -1,
      prefix: state.inputBuffer,
      tokenStart: 0,
      matches: [
        ...Array.from({ length: 10 }, (_, i) => ({
          name: `queue-target-${String(i).padStart(2, "0")}`,
          desc: "conversation",
        })),
        { name: `long-offscreen-${"x".repeat(500)}`, desc: "conversation" },
      ],
    };

    const writes = positionedWrites(captureRenderOutput(state));
    const autocompleteRows = writes
      .map(write => ({ ...write, plain: stripCsi(stripAnsi(write.text)) }))
      .filter(write => write.plain.includes("queue-target") || write.plain.includes("long-offscreen"));

    expect(autocompleteRows).toHaveLength(10);
    for (const row of autocompleteRows) {
      expect(row.col).toBe(1);
      expect(termWidth(row.plain)).toBeLessThanOrEqual(state.cols - 2);
    }
  });

  test("defers older chat-history rendering for first paint, then fills it in", () => {
    const state = createInitialState();
    state.cols = 100;
    state.rows = 30;
    state.convId = "big-conversation";
    state.panelFocus = "sidebar";
    state.messages = Array.from({ length: 40 }, (_, i) => ({
      role: "assistant" as const,
      blocks: [{ type: "text" as const, text: `${i === 0 ? "oldest" : i === 39 ? "newest" : "middle"}-${i} ${"word ".repeat(260)}` }],
      metadata: null,
    }));

    renderSilently(state);

    expect(state.deferredHistoryRender).not.toBeNull();
    expect(state.deferredHistoryRender!.complete).toBe(false);
    expect(stripAnsi(state.historyLines.join("\n"))).not.toContain("oldest-0");
    expect(stripAnsi(state.historyLines.join("\n"))).toContain("newest-39");

    while (hasDeferredHistoryRenderWork(state)) {
      expect(advanceDeferredHistoryRender(state)).toBe(true);
      renderSilently(state);
    }

    expect(state.deferredHistoryRender?.complete).toBe(true);
    expect(stripAnsi(state.historyLines.join("\n"))).toContain("oldest-0");
    expect(stripAnsi(state.historyLines.join("\n"))).toContain("newest-39");
  });

  test("abandoned deferred history work does not advance after conversation switch", () => {
    const state = createInitialState();
    state.cols = 100;
    state.rows = 30;
    state.convId = "first-conversation";
    state.panelFocus = "sidebar";
    state.messages = Array.from({ length: 40 }, (_, i) => ({
      role: "assistant" as const,
      blocks: [{ type: "text" as const, text: `${i} ${"word ".repeat(260)}` }],
      metadata: null,
    }));

    renderSilently(state);
    expect(hasDeferredHistoryRenderWork(state)).toBe(true);

    state.convId = "second-conversation";

    expect(hasDeferredHistoryRenderWork(state)).toBe(false);
    expect(advanceDeferredHistoryRender(state)).toBe(false);
  });
});
