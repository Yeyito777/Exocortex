import { describe, expect, test } from "bun:test";
import { renderBlockCached } from "./blockrenderer";
import { buildMessageLines } from "./conversation";
import { liveChronoFrame, msUntilLiveChronoChange } from "./chronocalls";
import type { Block, ConversationTaskSummary, ExternalToolStyle, ToolDisplayInfo } from "./messages";
import { createInitialState } from "./state";
import { theme } from "./theme";

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const registry: ToolDisplayInfo[] = [{ name: "chrono", label: "Chrono", color: "#4ec9b0" }];
const styles: ExternalToolStyle[] = [];
const ID = "1794036663304-sr0sel";

function call(input: Record<string, unknown>, presentation?: { subject: string }, toolCallId = "call-1"): Extract<Block, { type: "tool_call" }> {
  return { type: "tool_call", toolCallId, toolName: "chrono", input, summary: "", ...(presentation ? { presentation } : {}) };
}

const paint = (block: Block, expanded = false, progress?: { startedAt: number; dueAt: number; now: number }, showTarget = false) =>
  renderBlockCached(block, 100, registry, styles, expanded, false, false, { progress, showTarget });

describe("Chrono call lines", () => {
  test("a wait shows what it waits on in bold and its limit dim", () => {
    const rendered = paint(call({ action: "wait", task_id: ID, max_wait: "45m", what: "arm A price-move research agent" }));
    expect(rendered.lines.map(strip)).toEqual(["  Chrono wait: arm A price-move research agent  · up to 45m"]);
    expect(rendered.lines[0]).toContain(`${theme.bold}arm A price-move research agent${theme.boldOff}`);
    expect(rendered.lines[0]).toContain(`${theme.dim}· up to 45m`);
  });

  test("a sleep shows its what and duration, or just its duration", () => {
    expect(paint(call({ action: "sleep", duration: "5m", what: "letting the replay warm up" })).lines.map(strip))
      .toEqual(["  Chrono sleep: letting the replay warm up  · 5m"]);
    expect(paint(call({ action: "sleep", duration: "5m" })).lines.map(strip)).toEqual(["  Chrono sleep: 5m"]);
  });

  test("without a usable what a wait shows the daemon's name for its target, else its raw id", () => {
    expect(paint(call({ action: "wait", task_id: ID, max_wait: "45m" }, { subject: "arm A research" })).lines.map(strip))
      .toEqual(["  Chrono wait: arm A research  · up to 45m"]);
    expect(paint(call({ action: "wait", task_id: ID, max_wait: "45m", what: " " })).lines.map(strip))
      .toEqual([`  Chrono wait: ${ID}  · up to 45m`]);
  });

  test("expanded, a wait names its raw target on a dim second line", () => {
    const block = call({ action: "wait", task_id: ID, max_wait: "45m", what: "arm A research" });
    const rendered = paint(block, true);
    expect(rendered.lines.map(strip)).toEqual(["  Chrono wait: arm A research  · up to 45m", `    task ${ID}`]);
    expect(rendered.lines[1]).toStartWith(`    ${theme.dim}`);
    // The turn-work view (Ctrl+O) shows it without tool output.
    expect(paint(block, false, undefined, true).lines.map(strip)).toEqual(rendered.lines.map(strip));
    expect(paint(block).lines).toHaveLength(1);
    expect(paint(call({ action: "sleep", duration: "5m", what: "replay" }), true).lines).toHaveLength(1);
  });

  test("while running it counts up, and the cache follows the count", () => {
    const block = call({ action: "wait", task_id: ID, max_wait: "45m", what: "arm A research" });
    const at = (minutes: number) => paint(block, false, { startedAt: 0, dueAt: 45 * 60_000, now: minutes * 60_000 + 5_000 });
    expect(at(12).lines.map(strip)).toEqual(["  Chrono waiting on arm A research  · 12m of 45m"]);
    expect(at(12)).toBe(at(12));
    expect(at(13).lines.map(strip)).toEqual(["  Chrono waiting on arm A research  · 13m of 45m"]);
    expect(paint(block).lines.map(strip)).toEqual(["  Chrono wait: arm A research  · up to 45m"]);
  });
});

describe("running Chrono calls in history", () => {
  function waitingState(tasks: ConversationTaskSummary[]) {
    const state = createInitialState();
    state.convId = "conv-wait";
    state.toolRegistry = registry;
    state.sidebar.conversations = [{
      id: state.convId, provider: state.provider, model: state.model, effort: state.effort, fastMode: state.fastMode,
      createdAt: 1, updatedAt: 2, messageCount: 1, title: "Waiting", marked: false, pinned: false, streaming: false,
      unread: false, sortOrder: 0, tasks,
    }];
    state.messages.push({
      role: "assistant",
      blocks: [call({ action: "wait", task_id: ID, max_wait: "45m", what: "arm A research" }, undefined, "wait-call")],
      metadata: { startedAt: 1_000, endedAt: 2_000, model: state.model, tokens: 12 },
    });
    return state;
  }
  const task = (startedAt: number): ConversationTaskSummary => ({
    id: "chrono:wait:wait-call", kind: "chrono", title: "Waiting", startedAt, dueAt: startedAt + 45 * 60_000, chronoMode: "wait",
  });
  const chronoRow = (state: ReturnType<typeof waitingState>) =>
    buildMessageLines(state, 104).lines.map(strip).find(line => line.includes("Chrono"));

  test("a suspended wait stays in view counting up, and reads past tense once it ends", () => {
    const state = waitingState([task(Date.now() - 12 * 60_000 - 5_000)]);
    expect(chronoRow(state)).toBe("  Chrono waiting on arm A research  · 12m of 45m");

    state.sidebar.conversations[0].tasks = [task(Date.now() - 13 * 60_000 - 5_000)];
    expect(chronoRow(state)).toBe("  Chrono waiting on arm A research  · 13m of 45m");

    // Finished, it folds away with the turn's work; Ctrl+O shows it past tense.
    state.sidebar.conversations[0].tasks = [];
    expect(chronoRow(state)).toBeUndefined();
    state.showToolOutput = true;
    expect(chronoRow(state)).toBe("  Chrono wait: arm A research  · up to 45m");
  });

  test("a suspended wait too long for one row stays in full, not cut to the folded one-row form", () => {
    const state = waitingState([task(Date.now() - 12 * 60_000 - 5_000)]);
    const message = state.messages[0]!;
    if (message.role !== "assistant") throw new Error("not assistant");
    message.blocks = [call({ action: "wait", task_id: ID, max_wait: "45m", what: "the arm A price-move research lane" }, undefined, "wait-call")];
    const rendered = buildMessageLines(state, 40).lines.map(strip).filter(line => line.trim() && !/Opus|GPT|tokens/.test(line));
    expect(rendered.length).toBeGreaterThan(1);
    expect(rendered.join(" ")).toContain("12m of 45m");
    expect(rendered.join(" ")).not.toContain("…");
  });

  test("the frame key and next tick follow whole minutes", () => {
    const now = 10_000_000;
    const state = waitingState([task(now - 12 * 60_000 - 5_000)]);
    expect(liveChronoFrame(state, now)).toBe(liveChronoFrame(state, now + 50_000));
    expect(liveChronoFrame(state, now)).not.toBe(liveChronoFrame(state, now + 55_000));
    expect(msUntilLiveChronoChange(state, now)).toBe(55_000);
    expect(msUntilLiveChronoChange(waitingState([]), now)).toBeNull();
  });
});
