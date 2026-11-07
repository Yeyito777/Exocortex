import { describe, expect, test } from "bun:test";
import { renderTaskPanel } from "./activitypanel";
import type { ConversationSummary } from "./messages";
import { renderScratchpadPanel } from "./scratchpadpanel";
import { createInitialState } from "./state";

function opened(tasks: ConversationSummary["tasks"], scratchpad?: string) {
  const state = createInitialState();
  state.convId = "c";
  state.sidebar.conversations = [{
    id: "c", title: "C", provider: "anthropic", model: "claude-opus-5-5", effort: "high", fastMode: "off",
    createdAt: 1, updatedAt: 1, messageCount: 1, marked: false, pinned: false, streaming: false, unread: false,
    sortOrder: 0, tasks, ...(scratchpad ? { scratchpad: "h" } : {}),
  } as unknown as ConversationSummary];
  if (scratchpad) state.scratchpads.put("h", scratchpad);
  return state;
}

describe("the Tasks and Scratchpad cards on scroll frames", () => {
  test("the Tasks card is reused until an entry, its time as shown, the size or the expansion changes", () => {
    const now = 1_000_000;
    const state = opened([{ id: "t", kind: "chrono", title: "Covered price: day 1 check", startedAt: now - 5_000, dueAt: now + 3 * 3_600_000, chronoMode: "wake" }]);
    const first = renderTaskPanel(state, 120, 20, now);
    expect(first).not.toBeNull();
    // Glide frames within the same displayed time: the same card.
    expect(renderTaskPanel(state, 120, 20, now + 8)).toBe(first);
    expect(renderTaskPanel(state, 120, 20, now + 500)).toBe(first);
    // The countdown shows another hour: built again.
    expect(renderTaskPanel(state, 120, 20, now + 3_600_000)).not.toBe(first);
    const again = renderTaskPanel(state, 120, 20, now);
    expect(renderTaskPanel(state, 100, 20, now)).not.toBe(again);
    // A new task arrives in a new summary.
    const later = renderTaskPanel(state, 120, 20, now);
    state.sidebar.conversations = [{ ...state.sidebar.conversations[0]!, tasks: [...state.sidebar.conversations[0]!.tasks!, { id: "u", kind: "background", title: "make test", startedAt: now }] }];
    const withTwo = renderTaskPanel(state, 120, 20, now);
    expect(withTwo).not.toBe(later);
    expect(withTwo!.lines.some(line => line.includes("make test"))).toBe(true);
    state.taskPanelExpansion = { convId: "c", scroll: 0 };
    expect(renderTaskPanel(state, 120, 20, now)).not.toBe(withTwo);
  });

  test("the Scratchpad card is reused until its content, size or expansion changes", () => {
    const state = opened([], "# Now\n- one\n- two\n");
    const first = renderScratchpadPanel(state, 120, 20);
    expect(first).not.toBeNull();
    expect(renderScratchpadPanel(state, 120, 20)).toBe(first);
    expect(renderScratchpadPanel(state, 120, 12)).not.toBe(first);
    state.scratchpads.put("h2", "# Now\n- three\n");
    state.sidebar.conversations = [{ ...state.sidebar.conversations[0]!, scratchpad: "h2" }];
    const changed = renderScratchpadPanel(state, 120, 12);
    expect(changed!.lines.some(line => line.includes("three"))).toBe(true);
    state.scratchpadExpansion = { convId: "c", scroll: 0 };
    expect(renderScratchpadPanel(state, 120, 12)).not.toBe(changed);
  });
});
