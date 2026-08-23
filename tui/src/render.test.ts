import { describe, expect, test } from "bun:test";
import { createPendingAI } from "./messages";
import { advanceDeferredHistoryRender, hasDeferredHistoryRenderWork, render, invalidateHistoryRenderCache } from "./render";
import { createInitialState, type RenderState } from "./state";
import { invalidateFrame } from "./frame";
import { hexToAnsi, theme } from "./theme";
import { termWidth } from "./textwidth";
import { hide_cursor, show_cursor } from "./terminal";
import { SIDEBAR_WIDTH } from "./sidebar";
import { renderUserMessage } from "./blockrenderer";
import { scrollToTop } from "./chat";

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
  test("does not present the partial opening window before restoring a saved position", () => {
    const state = makeState();
    state.convId = "source";
    expect(captureRenderOutput(state)).not.toBe("");
    const previouslyPresentedLines = state.historyLines;

    state.convId = "target";
    state.messages = [{ role: "user", text: "target opening-window bottom", metadata: null }];
    state.scrollOffset = 0;
    state.conversationScroll.pendingRestore = {
      convId: "target",
      mode: "percentage",
      percentage: 0.25,
      waitForInitialBackfill: true,
    };

    expect(captureRenderOutput(state)).toBe("");
    expect(state.historyLines).toBe(previouslyPresentedLines);
    expect(state.conversationScroll.pendingRestore?.waitForInitialBackfill).toBe(true);

    state.conversationScroll.pendingRestore.waitForInitialBackfill = false;
    const restoredOutput = captureRenderOutput(state);
    expect(stripCsi(restoredOutput)).toContain("target opening-window bottom");
    expect(state.conversationScroll.pendingRestore).toBeNull();
  });

  test("preserves the sidebar background and border beside an expanded BTW panel", () => {
    const state = makeState();
    state.sidebar.open = true;
    state.btw = {
      sessionId: "btw-1",
      sourceConvId: "conv-1",
      query: "Summarize this conversation",
      provider: "openai",
      model: "gpt-5.4",
      startedAt: 100,
      endedAt: 200,
      phase: "complete",
      blocks: [{ type: "text", text: ["one", "two", "three", "four", "five"].join("\n") }],
      turns: [{
        id: "btw-1",
        query: "Summarize this conversation",
        startedAt: 100,
        endedAt: 200,
        phase: "complete",
        blocks: [{ type: "text", text: ["one", "two", "three", "four", "five"].join("\n") }],
        text: ["one", "two", "three", "four", "five"].join("\n"),
        status: "complete",
      }],
      text: ["one", "two", "three", "four", "five"].join("\n"),
      status: "complete",
      scrollOffset: 0,
      streamingResponseAutoscroll: null,
      maxScroll: 0,
      viewportRows: 1,
      historyCursor: { row: 0, col: 0 },
      historyCurswant: null,
      historyVisualAnchor: { row: 0, col: 0 },
      historyLines: [],
      historyWrapContinuation: [],
      historyWrapJoiners: [],
      historyCopyLines: [],
      historyMessageBounds: [],
      historyLineAnchors: [],
    };

    const writes = positionedWrites(captureRenderOutput(state));
    const panelTop = writes.find(write => (
      write.col === SIDEBAR_WIDTH + 1
      && stripAnsi(write.text).includes("Summarize this conversation")
    ));
    expect(panelTop).toBeDefined();

    for (let row = panelTop!.row; row < panelTop!.row + 7; row++) {
      const sidebarRow = writes.find(write => (
        write.row === row
        && write.col === 1
        && stripAnsi(write.text).endsWith("│")
      ));
      expect(sidebarRow).toBeDefined();
      expect(termWidth(stripAnsi(sidebarRow!.text))).toBe(SIDEBAR_WIDTH);
    }
  });

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

  test("renders the focused history cursor on an empty source line", () => {
    const state = createInitialState();
    state.cols = 100;
    state.rows = 20;
    state.panelFocus = "chat";
    state.chatFocus = "history";
    state.messages = [{
      role: "assistant",
      blocks: [{ type: "text", text: "before\n\nafter" }],
      metadata: null,
    }];

    captureRenderOutput(state);
    const blankRow = state.historyLines.findIndex(line => stripAnsi(line).trim().length === 0);
    expect(blankRow).toBeGreaterThanOrEqual(0);
    state.historyCursor = { row: blankRow, col: stripAnsi(state.historyLines[blankRow]).length };

    const output = captureRenderOutput(state);
    const viewportIndex = state.layout.historyViewportRows.findIndex(row => row?.lineIndex === blankRow);

    expect(viewportIndex).toBeGreaterThanOrEqual(0);
    expect(output).toContain(theme.cursorBg);
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
    state.goal = {
      objective: "Keep following autonomous output",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
      turns: 0,
    };
    captureRenderOutput(state); // prime previous-frame cache with an overflowing viewport

    (state.pendingAI.blocks[0] as { type: "text"; text: string }).text += (
      " More streaming text appended at the bottom of the same paragraph. "
    ).repeat(3);
    const out = captureRenderOutput(state);

    const clearCount = (out.match(/\x1b\[2K/g) || []).length;
    expect(out).toMatch(/\x1b\[3;\d+r/);
    expect(clearCount).toBeLessThan(state.layout.messageAreaHeight);
  });

  test("follows a non-goal final response, then holds its beginning when it overflows", () => {
    const state = createInitialState();
    state.cols = 80;
    state.rows = 16;
    state.messages = [{
      role: "assistant",
      blocks: [{
        type: "text",
        text: Array.from({ length: 30 }, (_, index) => `older ${String(index + 1).padStart(2, "0")}`).join("\n"),
      }],
      metadata: null,
    }];
    state.pendingAI = createPendingAI(123, state.model);
    const response = { type: "text" as const, text: "answer 01\nanswer 02" };
    state.pendingAI.blocks.push(response);
    state.scrollOffset = 8;

    renderSilently(state);
    expect(state.scrollOffset).toBe(0);
    expect(state.conversationScroll.streamingResponse?.mode).toBe("following");

    response.text = Array.from(
      { length: state.layout.messageAreaHeight + 2 },
      (_, index) => `answer ${String(index + 1).padStart(2, "0")}`,
    ).join("\n");
    renderSilently(state);

    const responseStart = state.historyLineAnchors.findIndex(anchor => anchor.owner === response);
    const viewStart = state.layout.totalLines - state.layout.messageAreaHeight - state.scrollOffset;
    expect(responseStart).toBeGreaterThanOrEqual(0);
    expect(state.conversationScroll.streamingResponse?.mode).toBe("anchored");
    expect(viewStart).toBe(responseStart);

    response.text += "\nanswer later 1\nanswer later 2";
    renderSilently(state);
    const grownViewStart = state.layout.totalLines - state.layout.messageAreaHeight - state.scrollOffset;
    expect(grownViewStart).toBe(responseStart);
  });

  test("keeps ordinary bottom following for active goals", () => {
    const state = createInitialState();
    state.cols = 80;
    state.rows = 16;
    state.goal = {
      objective: "Run autonomously",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
      turns: 0,
    };
    state.pendingAI = createPendingAI(123, state.model);
    state.pendingAI.blocks.push({
      type: "text",
      text: Array.from({ length: 30 }, (_, index) => `goal row ${index + 1}`).join("\n"),
    });

    renderSilently(state);

    expect(state.scrollOffset).toBe(0);
    expect(state.conversationScroll.streamingResponse).toBeNull();
  });

  test("opens a completed unread conversation at its overflowing final response", () => {
    const state = createInitialState();
    state.convId = "background-complete";
    state.cols = 80;
    state.rows = 16;
    const finalResponse = {
      type: "text" as const,
      text: Array.from({ length: 30 }, (_, index) => `unread answer ${String(index + 1).padStart(2, "0")}`).join("\n"),
    };
    state.messages = [
      { role: "user", text: "Work in the background", metadata: null },
      {
        role: "assistant",
        blocks: [
          { type: "thinking", text: "Background work completed" },
          finalResponse,
        ],
        metadata: null,
      },
    ];
    state.conversationScroll.pendingRestore = {
      convId: "background-complete",
      mode: "unread-response",
      waitForInitialBackfill: false,
    };

    renderSilently(state);

    const responseStart = state.historyLineAnchors.findIndex(anchor => anchor.owner === finalResponse);
    const viewStart = state.layout.totalLines - state.layout.messageAreaHeight - state.scrollOffset;
    expect(responseStart).toBeGreaterThanOrEqual(0);
    expect(viewStart).toBe(responseStart);
    expect(state.pendingAI).toBeNull();
    expect(state.conversationScroll.pendingRestore).toBeNull();
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

  test("keeps the first user-message row visible at the top of task-panel history", () => {
    const state = createInitialState();
    state.cols = 120;
    state.rows = 20;
    state.convId = "parent";
    const firstMessage = [
      `FIRST ROW ${"alpha ".repeat(15)}`,
      `SECOND ROW ${"beta ".repeat(15)}`,
      `THIRD ROW ${"gamma ".repeat(15)}`,
    ].join("\n");
    state.messages = [
      { role: "user", text: firstMessage, metadata: null },
      {
        role: "assistant",
        blocks: Array.from({ length: 30 }, (_, index) => ({
          type: "text" as const,
          text: `L${String(index).padStart(2, "0")} ${"history words ".repeat(6)}`,
        })),
        metadata: null,
      },
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
      tasks: [{ id: "child", kind: "subagent", title: "Task", startedAt: Date.now() - 2_000 }],
    }];

    renderSilently(state);
    scrollToTop(state);
    invalidateFrame(state);
    const writes = positionedWrites(captureRenderOutput(state));
    const firstUserRow = state.layout.historyViewportRows.findIndex(viewportRow => (
      viewportRow && state.historyLineAnchors[viewportRow.lineIndex]?.segment === "user_content"
    ));
    const firstUserWrite = writes.filter(write => (
      write.row === 3 + firstUserRow && write.col === 1
    )).at(-1);

    expect(firstUserRow).toBe(0);
    expect(state.layout.historyViewportRows[0]).toMatchObject({ lineIndex: 0, startCol: 0 });
    expect(stripCsi(stripAnsi(firstUserWrite?.text ?? ""))).toContain("FIRST ROW");
  });

  test("places tasks below system instructions and wraps chat history beside them", () => {
    const state = createInitialState();
    state.cols = 120;
    state.rows = 40;
    state.convId = "parent";
    state.messages = [
      { role: "system_instructions", text: "Keep this full-width instruction box visible.", metadata: null },
      {
        role: "assistant",
        blocks: [
          { type: "text", text: `OVERLAP ${"history words ".repeat(6)}` },
          { type: "text", text: "filler" },
          { type: "text", text: `BELOW ${"full width words ".repeat(6)}` },
          { type: "text", text: `AFTER ${"full width again ".repeat(6)}` },
        ],
        metadata: null,
      },
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
    const taskHeader = writes.find(write => (
      write.row === 7
      && write.col === 71
      && stripAnsi(write.text).includes("Tasks")
    ));
    const instructionLines = state.historyLines.filter((_, index) => (
      state.historyLineAnchors[index]?.segment.startsWith("system_instructions")
    ));
    const assistantLines = state.historyLines.filter((_, index) => (
      state.historyLineAnchors[index]?.segment === "assistant_block"
    ));
    const overlappingHistoryWrites = writes.filter(write => (
      write.col === 1
      && write.row >= 7
      && write.row <= 9
      && /OVERLAP|history words|filler/.test(stripAnsi(write.text))
    ));
    const belowPanel = writes.find(write => (
      write.col === 1
      && write.row === 12
      && stripAnsi(write.text).includes("AFTER")
    ));
    const bufferRow = writes.find(write => (
      write.col === 1
      && write.row === 10
      && stripAnsi(write.text).includes("BELOW")
    ));

    expect(taskHeader).toBeDefined();
    expect(state.layout.historyWidth).toBe(69);
    expect(instructionLines).toHaveLength(4);
    expect(instructionLines.slice(0, -1).every(line => termWidth(stripAnsi(line)) === 120)).toBe(true);
    expect(instructionLines.at(-1)).toBe("");
    expect(assistantLines).toHaveLength(4);
    expect(overlappingHistoryWrites.length).toBeGreaterThan(0);
    expect(overlappingHistoryWrites.every(write => termWidth(stripCsi(stripAnsi(write.text))) <= state.layout.historyWidth)).toBe(true);
    expect(bufferRow).toBeDefined();
    expect(termWidth(stripCsi(stripAnsi(bufferRow!.text)))).toBeLessThanOrEqual(state.layout.historyWidth);
    expect(belowPanel).toBeDefined();
    expect(termWidth(stripCsi(stripAnsi(belowPanel!.text)))).toBeGreaterThan(state.layout.historyWidth);
  });

  test("keeps a system-instructions box full-width when top-anchored task-panel reflow reaches it", () => {
    const state = createInitialState();
    state.cols = 120;
    state.rows = 30;
    state.convId = "parent";
    state.messages = [
      {
        role: "assistant",
        blocks: [{ type: "text", text: `BEFORE ${"history words ".repeat(6)}` }],
        metadata: null,
      },
      { role: "system_instructions", text: "Keep this box intact.", metadata: null },
      {
        role: "assistant",
        blocks: Array.from({ length: 13 }, (_, index) => ({
          type: "text" as const,
          text: `AFTER${index} ${"history words ".repeat(6)}`,
        })),
        metadata: null,
      },
    ];
    state.sidebar.conversations = [{
      id: "parent",
      provider: state.provider,
      model: state.model,
      effort: state.effort,
      fastMode: state.fastMode,
      createdAt: 1,
      updatedAt: 2,
      messageCount: 3,
      title: "Parent",
      marked: false,
      pinned: false,
      streaming: false,
      unread: false,
      sortOrder: 0,
      tasks: Array.from({ length: 27 }, (_, index) => ({
        id: `child-${index}`,
        kind: "subagent" as const,
        title: `Task ${index}`,
        startedAt: Date.now() - 2_000,
      })),
    }];

    captureRenderOutput(state);
    const instructionRows = state.layout.historyViewportRows.filter((viewportRow) => (
      viewportRow
      && state.historyLineAnchors[viewportRow.lineIndex]?.segment.startsWith("system_instructions")
    ));

    expect(instructionRows.map(row => row?.lineIndex)).toEqual([1, 2, 3, 4]);
    expect(state.layout.taskPanelRect?.top).toBe(8);
    expect(instructionRows.slice(0, -1).every(row => (
      row !== null && termWidth(stripAnsi(state.historyLines[row.lineIndex])) === state.cols
    ))).toBe(true);
    expect(state.historyLines[instructionRows.at(-1)!.lineIndex]).toBe("");
  });

  test("preserves assistant indentation on task-panel reflow continuations", () => {
    const state = createInitialState();
    state.cols = 180;
    state.rows = 30;
    state.convId = "parent";
    const text = ("Your instinct is exactly right—you are already enumerating the rows of a truth table, while standard notation puts the truth values into columns instead of writing each case as a sentence. ").repeat(3).trim();
    state.messages = [{
      role: "assistant",
      blocks: [{ type: "text", text }],
      metadata: null,
    }];
    state.sidebar.conversations = [{
      id: "parent",
      provider: state.provider,
      model: state.model,
      effort: state.effort,
      fastMode: state.fastMode,
      createdAt: 1,
      updatedAt: 2,
      messageCount: 1,
      title: "Parent",
      marked: false,
      pinned: false,
      streaming: false,
      unread: false,
      sortOrder: 0,
      tasks: Array.from({ length: 7 }, (_, index) => ({
        id: `child-${index}`,
        kind: "subagent" as const,
        title: `Task ${index}`,
        startedAt: Date.now() - 2_000,
      })),
    }];

    const writes = positionedWrites(captureRenderOutput(state));
    const assistantRows = state.layout.historyViewportRows.flatMap((viewportRow, index) => {
      if (!viewportRow || state.historyLineAnchors[viewportRow.lineIndex]?.segment !== "assistant_block") return [];
      const write = writes.filter(candidate => candidate.row === 3 + index && candidate.col === 1).at(-1);
      return [{ viewportRow, line: stripCsi(stripAnsi(write?.text ?? "")) }];
    });

    expect(assistantRows.some(row => row.viewportRow.displayPrefixWidth === 2)).toBe(true);
    expect(assistantRows.every(row => row.line.startsWith("  "))).toBe(true);
    expect(assistantRows.map(row => row.line.trim()).join(" ")).toBe(text);
  });

  test("rewraps user bubbles as one continuous message beside the task panel", () => {
    const state = createInitialState();
    state.cols = 180;
    state.rows = 30;
    state.convId = "parent";
    const text = "And for the nametag I sometimes put preferred name as Yeyito for the funsies it is kind of like a nickname of mine that people refer to me as sometimes and I find it cool but idk you can put whichever lol";
    state.messages = [{ role: "user", text, metadata: null }];
    state.sidebar.conversations = [{
      id: "parent",
      provider: state.provider,
      model: state.model,
      effort: state.effort,
      fastMode: state.fastMode,
      createdAt: 1,
      updatedAt: 2,
      messageCount: 1,
      title: "Parent",
      marked: false,
      pinned: false,
      streaming: false,
      unread: false,
      sortOrder: 0,
      tasks: Array.from({ length: 7 }, (_, index) => ({
        id: `child-${index}`,
        kind: "subagent" as const,
        title: `Task ${index}`,
        startedAt: Date.now() - 2_000,
      })),
    }];

    const writes = positionedWrites(captureRenderOutput(state));
    const expected = renderUserMessage(text, state.layout.historyWidth).lines.map(line => stripAnsi(line));
    const actual = expected.map((_, index) => {
      const write = writes.filter(candidate => candidate.row === 3 + index && candidate.col === 1).at(-1);
      return stripCsi(stripAnsi(write?.text ?? ""));
    });

    expect(actual).toEqual(expected);
    expect(actual.every(line => termWidth(line) <= state.layout.historyWidth)).toBe(true);
    expect(actual.map(line => line.trim()).join(" ")).toBe(text);
  });

  test("preserves hard breaks and empty lines while rewrapping a user bubble", () => {
    const state = createInitialState();
    state.cols = 180;
    state.rows = 30;
    state.convId = "parent";
    const text = "And for the nametag I sometimes put preferred name as Yeyito for the funsies it is kind of like a nickname of mine that people refer to me as sometimes and I find it cool\n\nbut idk you can put whichever lol";
    state.messages = [{ role: "user", text, metadata: null }];
    state.sidebar.conversations = [{
      id: "parent",
      provider: state.provider,
      model: state.model,
      effort: state.effort,
      fastMode: state.fastMode,
      createdAt: 1,
      updatedAt: 2,
      messageCount: 1,
      title: "Parent",
      marked: false,
      pinned: false,
      streaming: false,
      unread: false,
      sortOrder: 0,
      tasks: Array.from({ length: 7 }, (_, index) => ({
        id: `child-${index}`,
        kind: "subagent" as const,
        title: `Task ${index}`,
        startedAt: Date.now() - 2_000,
      })),
    }];

    const writes = positionedWrites(captureRenderOutput(state));
    const expected = renderUserMessage(text, state.layout.historyWidth).lines.map(line => stripAnsi(line));
    const actual = expected.map((_, index) => {
      const write = writes.filter(candidate => candidate.row === 3 + index && candidate.col === 1).at(-1);
      return stripCsi(stripAnsi(write?.text ?? ""));
    });

    expect(actual).toEqual(expected);
    expect(actual.filter(line => line.trim() === "")).toHaveLength(1);
    expect(actual.every(line => termWidth(line) <= state.layout.historyWidth)).toBe(true);
  });

  test("expands a user bubble after the panel buffer without losing text", () => {
    const state = createInitialState();
    state.cols = 120;
    state.rows = 30;
    state.convId = "parent";
    const text = Array.from({ length: 60 }, (_, index) => `word${index}`).join(" ");
    state.messages = [{ role: "user", text, metadata: null }];
    state.sidebar.conversations = [{
      id: "parent",
      provider: state.provider,
      model: state.model,
      effort: state.effort,
      fastMode: state.fastMode,
      createdAt: 1,
      updatedAt: 2,
      messageCount: 1,
      title: "Parent",
      marked: false,
      pinned: false,
      streaming: false,
      unread: false,
      sortOrder: 0,
      tasks: [{ id: "child", kind: "subagent", title: "Task", startedAt: Date.now() - 2_000 }],
    }];

    const writes = positionedWrites(captureRenderOutput(state));
    const userRows = state.layout.historyViewportRows.flatMap((viewportRow, index) => {
      if (!viewportRow || state.historyLineAnchors[viewportRow.lineIndex]?.segment !== "user_content") return [];
      const write = writes.filter(candidate => candidate.row === 3 + index && candidate.col === 1).at(-1);
      const line = stripCsi(stripAnsi(write?.text ?? ""));
      return [{ screenRow: 3 + index, line }];
    });
    const bufferBottom = (state.layout.taskPanelRect?.bottom ?? 0) + 1;

    expect(userRows.map(row => row.line.trim()).join(" ")).toBe(text);
    expect(userRows.filter(row => row.screenRow <= bufferBottom)
      .every(row => termWidth(row.line) <= state.layout.historyWidth)).toBe(true);
    expect(userRows.some(row => row.screenRow > bufferBottom && termWidth(row.line) > state.layout.historyWidth)).toBe(true);
  });

  test("keeps the newest full-width tail fixed when task-panel reflow overflows", () => {
    const state = createInitialState();
    state.cols = 120;
    state.rows = 30;
    state.convId = "parent";
    state.messages = [{
      role: "assistant",
      blocks: Array.from({ length: 30 }, (_, index) => ({
        type: "text" as const,
        text: `L${String(index).padStart(2, "0")} ${"history words ".repeat(6)}`,
      })),
      metadata: null,
    }];
    state.sidebar.conversations = [{
      id: "parent",
      provider: state.provider,
      model: state.model,
      effort: state.effort,
      fastMode: state.fastMode,
      createdAt: 1,
      updatedAt: 2,
      messageCount: 1,
      title: "Parent",
      marked: false,
      pinned: false,
      streaming: false,
      unread: false,
      sortOrder: 0,
      tasks: Array.from({ length: 27 }, (_, index) => ({
        id: `child-${index}`,
        kind: "subagent" as const,
        title: `Task ${index}`,
        startedAt: Date.now() - 2_000,
      })),
    }];

    const writes = positionedWrites(captureRenderOutput(state));
    const panelBufferBottom = (state.layout.taskPanelRect?.bottom ?? 0) + 1;
    const historyRows = state.layout.historyViewportRows.map((viewportRow, index) => {
      const screenRow = 3 + index;
      const write = writes.filter(candidate => candidate.row === screenRow && candidate.col === 1).at(-1);
      return {
        screenRow,
        viewportRow,
        line: stripCsi(stripAnsi(write?.text ?? "")),
      };
    });
    const narrowRows = historyRows.filter(row => row.screenRow <= panelBufferBottom);
    const fullRows = historyRows.filter(row => row.screenRow > panelBufferBottom);

    expect(state.layout.messageAreaHeight).toBe(23);
    expect(narrowRows).toHaveLength(13);
    expect(narrowRows[0].viewportRow?.startCol).toBeGreaterThan(0);
    expect(narrowRows[0].viewportRow?.displayPrefixWidth).toBe(2);
    expect(narrowRows[0].line.startsWith("  ")).toBe(true);
    expect(narrowRows.every(row => termWidth(row.line) <= state.layout.historyWidth)).toBe(true);
    expect(Math.max(...narrowRows.map(row => row.viewportRow?.lineIndex ?? -1))).toBe(19);
    expect(fullRows.map(row => row.viewportRow?.lineIndex)).toEqual(
      Array.from({ length: 10 }, (_, index) => 20 + index),
    );
    expect(fullRows.map(row => row.line.trim().slice(0, 3))).toEqual(
      Array.from({ length: 10 }, (_, index) => `L${20 + index}`),
    );
    expect(fullRows.every(row => termWidth(row.line) > state.layout.historyWidth)).toBe(true);
  });

  test("keeps an overflowing user bubble continuous across the fixed-width boundary", () => {
    const state = createInitialState();
    state.cols = 120;
    state.rows = 30;
    state.convId = "parent";
    const words = Array.from({ length: 500 }, (_, index) => `word${String(index).padStart(3, "0")}`);
    state.messages = [{ role: "user", text: words.join(" "), metadata: null }];
    state.sidebar.conversations = [{
      id: "parent",
      provider: state.provider,
      model: state.model,
      effort: state.effort,
      fastMode: state.fastMode,
      createdAt: 1,
      updatedAt: 2,
      messageCount: 1,
      title: "Parent",
      marked: false,
      pinned: false,
      streaming: false,
      unread: false,
      sortOrder: 0,
      tasks: Array.from({ length: 27 }, (_, index) => ({
        id: `child-${index}`,
        kind: "subagent" as const,
        title: `Task ${index}`,
        startedAt: Date.now() - 2_000,
      })),
    }];

    const writes = positionedWrites(captureRenderOutput(state));
    const panelBufferBottom = (state.layout.taskPanelRect?.bottom ?? 0) + 1;
    const userRows = state.layout.historyViewportRows.flatMap((viewportRow, index) => {
      if (!viewportRow || state.historyLineAnchors[viewportRow.lineIndex]?.segment !== "user_content") return [];
      const screenRow = 3 + index;
      const write = writes.filter(candidate => candidate.row === screenRow && candidate.col === 1).at(-1);
      return [{ screenRow, line: stripCsi(stripAnsi(write?.text ?? "")) }];
    });
    const visibleWords = userRows.flatMap(row => row.line.trim().split(/\s+/).filter(Boolean));
    const sourceStart = words.indexOf(visibleWords[0]);

    expect(sourceStart).toBeGreaterThan(0); // the top of the overflowing bubble is clipped
    expect(visibleWords).toEqual(words.slice(sourceStart));
    expect(userRows.filter(row => row.screenRow <= panelBufferBottom)
      .every(row => termWidth(row.line) <= state.layout.historyWidth)).toBe(true);
    expect(userRows.some(row => row.screenRow > panelBufferBottom
      && termWidth(row.line) > state.layout.historyWidth)).toBe(true);
  });

  test("keeps canonical scroll state stable when task-panel wrapping appears and disappears", () => {
    const state = createInitialState();
    state.cols = 120;
    state.rows = 20;
    state.convId = "parent";
    state.panelFocus = "chat";
    state.chatFocus = "history";
    state.messages = [{
      role: "assistant",
      blocks: Array.from({ length: 30 }, (_, index) => ({
        type: "text" as const,
        text: `L${String(index).padStart(2, "0")} ${"history words ".repeat(6)}`,
      })),
      metadata: null,
    }];
    state.sidebar.conversations = [{
      id: "parent",
      provider: state.provider,
      model: state.model,
      effort: state.effort,
      fastMode: state.fastMode,
      createdAt: 1,
      updatedAt: 2,
      messageCount: 1,
      title: "Parent",
      marked: false,
      pinned: false,
      streaming: false,
      unread: false,
      sortOrder: 0,
      tasks: [],
    }];

    captureRenderOutput(state);
    const targetRow = state.historyLines.findIndex(line => stripAnsi(line).includes("L08"));
    state.scrollOffset = state.layout.totalLines - state.layout.messageAreaHeight - targetRow;
    state.historyCursor = { row: targetRow, col: 2 };
    state.historyVisualAnchor = { row: targetRow, col: 2 };
    captureRenderOutput(state);

    state.sidebar.conversations[0].tasks = [{
      id: "child",
      kind: "subagent",
      title: "Inspect renderer flow",
      startedAt: Date.now() - 2_000,
    }];
    captureRenderOutput(state);

    const viewStart = state.layout.totalLines - state.layout.messageAreaHeight - state.scrollOffset;
    expect(stripAnsi(state.historyLines[viewStart])).toContain("L08");
    expect(stripAnsi(state.historyLines[state.historyCursor.row])).toContain("L08");
    expect(stripAnsi(state.historyLines[state.historyVisualAnchor.row])).toContain("L08");

    state.sidebar.conversations[0].tasks = [];
    captureRenderOutput(state);

    expect(stripAnsi(state.historyLines[viewStart])).toContain("L08");
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

  test("autocomplete descriptions render color swatches as full blocks", () => {
    const state = createInitialState();
    state.cols = 120;
    state.rows = 30;
    state.panelFocus = "chat";
    state.chatFocus = "prompt";
    state.vim.mode = "insert";
    state.inputBuffer = "/theme ";
    state.cursorPos = state.inputBuffer.length;
    const colors = ["#1d9bf0", "#48cae4", "#00050f"];
    state.autocomplete = {
      type: "command",
      selection: -1,
      prefix: state.inputBuffer,
      tokenStart: 0,
      matches: [{ name: "whale", desc: "███", colorSwatches: colors }],
    };

    const output = captureRenderOutput(state);

    expect(stripCsi(stripAnsi(output))).toContain("whale ███");
    for (const color of colors) {
      expect(output).toContain(`${hexToAnsi(color)}█`);
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

  test("fills first paint with complete newest turns up to one viewport of buffer", () => {
    const state = createInitialState();
    state.cols = 212;
    state.rows = 57;
    state.convId = "turn-sized-conversation";
    state.panelFocus = "sidebar";
    state.messages = [
      { role: "user", text: "oldest-user", metadata: null },
      { role: "assistant", blocks: [{ type: "text", text: `oldest-hidden ${"word ".repeat(4000)}` }], metadata: null },
      { role: "user", text: "older-user", metadata: null },
      { role: "assistant", blocks: [{ type: "text", text: `older-hidden ${"word ".repeat(4000)}` }], metadata: null },
      { role: "user", text: "fill-user", metadata: null },
      { role: "assistant", blocks: [{ type: "text", text: `fill-visible ${"word ".repeat(4000)}` }], metadata: null },
      { role: "user", text: "recent-user", metadata: null },
      { role: "assistant", blocks: [{ type: "text", text: "recent-answer" }], metadata: null },
      { role: "user", text: "newest-user", metadata: null },
      { role: "assistant", blocks: [{ type: "text", text: "newest-answer" }], metadata: null },
    ];

    renderSilently(state);

    const firstPaint = stripAnsi(state.historyLines.join("\n"));
    expect(state.deferredHistoryRender).toMatchObject({ startMessageIndex: 4, complete: false });
    expect(state.historyLines.length).toBeGreaterThanOrEqual(state.layout.messageAreaHeight * 2);
    expect(firstPaint).toContain("fill-visible");
    expect(firstPaint).toContain("newest-answer");
    expect(firstPaint).not.toContain("older-hidden");
    expect(firstPaint).not.toContain("oldest-hidden");

    expect(advanceDeferredHistoryRender(state)).toBe(true);
    renderSilently(state);
    expect(state.deferredHistoryRender).toMatchObject({ startMessageIndex: 2, complete: false });
    expect(stripAnsi(state.historyLines.join("\n"))).toContain("older-hidden");
    expect(stripAnsi(state.historyLines.join("\n"))).not.toContain("oldest-hidden");

    expect(advanceDeferredHistoryRender(state)).toBe(true);
    renderSilently(state);
    expect(state.deferredHistoryRender).toMatchObject({ startMessageIndex: 0, complete: true });
    expect(stripAnsi(state.historyLines.join("\n"))).toContain("oldest-hidden");
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
