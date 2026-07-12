import { describe, expect, test } from "bun:test";

import { renderTaskPanel, formatTaskCountdown, formatTaskElapsed } from "./activitypanel";
import { stripAnsi } from "./historycursor";
import { createInitialState } from "./state";
import { termWidth, visibleLength } from "./textwidth";
import { hexToAnsi, hexToAnsiBg, theme } from "./theme";

function stateWithTasks() {
  const state = createInitialState();
  state.convId = "parent";
  state.toolRegistry = [
    { name: "exo", label: "Exocortex", color: "#1122ee" },
    { name: "bash", label: "$", color: "#ee9911" },
    { name: "goal", label: "Goal", color: "#cc77dd" },
    { name: "chrono", label: "Chrono", color: "#11ccaa" },
  ];
  state.sidebar.conversations = [{
    id: "parent",
    provider: state.provider,
    model: state.model,
    effort: state.effort,
    fastMode: state.fastMode,
    createdAt: 1,
    updatedAt: 2,
    messageCount: 0,
    title: "Parent",
    marked: false,
    pinned: false,
    streaming: false,
    unread: false,
    sortOrder: 0,
    tasks: [
      { id: "child", kind: "subagent", title: "Map daemon events", startedAt: 1_000 },
      { id: "bash:42", kind: "background", title: "bun\ntest tui", startedAt: 12_000 },
    ],
  }];
  return state;
}

describe("focused conversation task panel", () => {
  test("matches the approved task card styling and tool colors", () => {
    const panel = renderTaskPanel(stateWithTasks(), 100, 20, 43_000);
    expect(panel).not.toBeNull();
    expect(panel?.width).toBe(50);
    expect(panel?.lines).toHaveLength(4);

    const plain = panel!.lines.map(stripAnsi);
    expect(plain[0]).toContain("Tasks");
    expect(plain[0].trimEnd()).toEndWith("2 ─╮");
    expect(plain[1]).toContain("◆ Exocortex Map daemon events");
    expect(plain[1]).toContain("42s");
    expect(plain[2]).toContain("$ Bash bun test tui");
    expect(panel!.lines[0]).toContain(theme.bold + theme.muted);
    expect(panel!.lines[0]).toContain(theme.muted + "Tasks");
    expect(panel!.lines[1]).toContain(hexToAnsi("#1122ee"));
    expect(panel!.lines[2]).toContain(hexToAnsi("#ee9911"));
    expect(panel!.lines.every(line => line.includes(hexToAnsiBg("#00050f")))).toBe(true);
    expect(panel!.lines.every(line => visibleLength(line) === panel!.width)).toBe(true);
  });

  test("shrinks, truncates, and reports overflow without breaking borders", () => {
    const state = stateWithTasks();
    state.sidebar.conversations[0].tasks!.push(
      { id: "child-2", kind: "subagent", title: "A very long title that cannot fit", startedAt: 2_000 },
      { id: "bash:99", kind: "background", title: "bun run typecheck", startedAt: 3_000 },
    );

    const panel = renderTaskPanel(state, 32, 5, 50_000);
    expect(panel?.width).toBe(32);
    expect(panel?.lines).toHaveLength(5);
    expect(panel?.lines.map(stripAnsi).join("\n")).toContain("… 2 more");
    expect(panel?.lines.every(line => termWidth(stripAnsi(line)) === 32)).toBe(true);
  });

  test("is absent without focused tasks or enough room", () => {
    const state = stateWithTasks();
    state.sidebar.conversations[0].tasks = [];
    expect(renderTaskPanel(state, 100, 20)).toBeNull();
    state.sidebar.conversations[0].tasks = [{ id: "x", kind: "subagent", title: "One task", startedAt: 0 }];
    expect(renderTaskPanel(state, 29, 20)).toBeNull();
    expect(renderTaskPanel(state, 100, 2)).toBeNull();
  });

  test("shows active and paused goals as tool-colored tasks", () => {
    const state = stateWithTasks();
    state.sidebar.conversations[0].tasks = [];
    state.goal = {
      objective: "Ship the activity panel",
      status: "active",
      createdAt: 1_000,
      updatedAt: 1_000,
      turns: 2,
    };

    const active = renderTaskPanel(state, 100, 20, 43_000);
    expect(active?.lines).toHaveLength(3);
    expect(active?.lines.map(stripAnsi).join("\n")).toContain("◆ Goal");
    expect(active?.lines.map(stripAnsi).join("\n")).toContain("Ship the activity panel");
    expect(active?.lines.map(stripAnsi).join("\n")).toContain("42s");
    expect(active?.lines[1]).toContain(hexToAnsi("#cc77dd"));

    state.goal.status = "paused";
    const paused = renderTaskPanel(state, 100, 20, 43_000);
    expect(paused?.lines.map(stripAnsi).join("\n")).toContain("◇ Goal");
    expect(paused?.lines.map(stripAnsi).join("\n")).toContain("paused");

    state.goal.status = "complete";
    expect(renderTaskPanel(state, 100, 20, 43_000)).toBeNull();
  });

  test("renders scheduled Chrono rows but omits explicit waits", () => {
    const state = stateWithTasks();
    state.sidebar.conversations[0].tasks = [
      { id: "chrono:sleep", kind: "chrono", title: "Resume the build", startedAt: 1_000, dueAt: 12 * 60_000, chronoMode: "sleep" },
      { id: "chrono:wait", kind: "chrono", title: "Wait for confirmation", startedAt: 1_000, dueAt: 12 * 60_000, chronoMode: "wait" },
      { id: "chrono:wake", kind: "chrono", title: "Late wake", startedAt: 1_000, dueAt: 0, chronoMode: "wake" },
    ];

    const panel = renderTaskPanel(state, 100, 20, 0);
    const plain = panel!.lines.map(stripAnsi).join("\n");
    expect(plain).toContain("◷ Chrono Resume the build");
    expect(plain).toContain("in 12m");
    expect(plain).not.toContain("Wait for confirmation");
    expect(plain).toContain("Late wake");
    expect(plain).toContain("due");
    expect(panel!.lines).toHaveLength(4);
    expect(panel!.lines.slice(1, 3).every(line => line.includes(hexToAnsi("#11ccaa")))).toBe(true);
    expect(panel!.lines.every(line => visibleLength(line) === panel!.width)).toBe(true);

    state.sidebar.conversations[0].tasks = [
      { id: "chrono:wait-only", kind: "chrono", title: "Wait for confirmation", startedAt: 1_000, chronoMode: "wait" },
    ];
    expect(renderTaskPanel(state, 100, 20, 0)).toBeNull();
  });

  test("uses Chrono's fallback color when it is absent from the tool registry", () => {
    const state = stateWithTasks();
    state.toolRegistry = state.toolRegistry.filter(tool => tool.name !== "chrono");
    state.sidebar.conversations[0].tasks = [
      { id: "chrono:sleep", kind: "chrono", title: "Sleep", startedAt: 1_000, chronoMode: "sleep" },
    ];

    expect(renderTaskPanel(state, 100, 20, 43_000)?.lines[1]).toContain(hexToAnsi("#4ec9b0"));
  });
});

describe("task elapsed formatting", () => {
  test("uses compact units at second, minute, hour, day, and week scales", () => {
    expect(formatTaskElapsed(1_000, 43_000)).toBe("42s");
    expect(formatTaskElapsed(0, 62_000)).toBe("1m 2s");
    expect(formatTaskElapsed(0, (3 * 60 + 4) * 60_000)).toBe("3h 4m");
    expect(formatTaskElapsed(0, (2 * 24 + 3) * 60 * 60_000)).toBe("2d 3h");
    expect(formatTaskElapsed(0, 9 * 24 * 60 * 60_000)).toBe("1w 2d");
  });

  test("renders scheduled Chrono times as a compact countdown or due", () => {
    expect(formatTaskCountdown(12 * 60_000, 0)).toBe("in 12m");
    expect(formatTaskCountdown(0, 0)).toBe("due");
  });
});
