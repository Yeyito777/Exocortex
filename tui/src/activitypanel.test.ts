import { describe, expect, test } from "bun:test";

import {
  focusedConversationIntegrations,
  focusedConversationTasks,
  formatIntegrationDeliveryStatus,
  formatTaskCountdown,
  formatTaskElapsed,
  hasFocusedConversationIntegrations,
  hasFocusedConversationTasks,
  layoutTaskPanel,
  MAX_TASK_PANEL_HEIGHT,
  msUntilTaskPanelEntryUpdate,
  renderSubscriptionsPanel,
  renderTaskPanel,
  toggleSubscriptionsExpansion,
  toggleTaskPanelExpansion,
} from "./activitypanel";
import { layoutSidePanels } from "./scratchpadpanel";
import { toggleCardFold } from "./sidecards";
import { stripAnsi } from "./historycursor";
import type { ExternalIntegrationSummary } from "./messages";
import { renderSidebar } from "./sidebar/render";
import { createInitialState } from "./state";
import { termWidth, visibleLength } from "./textwidth";
import { hexToAnsi, hexToAnsiBg, theme } from "./theme";

function integration(overrides: Partial<ExternalIntegrationSummary> = {}): ExternalIntegrationSummary {
  return {
    id: "integration:discord:design",
    toolName: "discord",
    sourceId: "channel:design",
    label: "Design alerts",
    delivery: "wake",
    status: "active",
    createdAt: 1_000,
    ...overrides,
  };
}

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

function stateWithIntegrations() {
  const state = stateWithTasks();
  state.sidebar.conversations[0].tasks = [];
  state.externalToolStyles = [
    { cmd: "discord", label: "Discord", color: "#5865f2" },
    { cmd: "whatsapp", label: "WhatsApp", color: "#25d366" },
  ];
  state.sidebar.conversations[0].integrations = [
    integration(),
    integration({
      id: "integration:whatsapp:ops",
      toolName: "whatsapp",
      sourceId: "group:ops",
      label: "Ops\nroom",
      delivery: "inbox",
      status: "offline",
      createdAt: 2_000,
    }),
  ];
  return state;
}

function withDisabledTools<T extends ReturnType<typeof stateWithTasks>>(state: T): T {
  state.toolRegistry.push(
    { name: "read", label: "Read", color: "#82aaff" },
    { name: "write", label: "Write", color: "#c792ea" },
  );
  state.externalToolStyles.push(
    { cmd: "gmail", label: "Gmail", color: "#4ddbb7" },
    { cmd: "google", label: "Google", color: "#4285f4" },
  );
  (state as any).activeToolPolicy = {
    convId: "parent",
    scoped: false,
    source: "explicit",
    internal: [
      { name: "bash", label: "$", enabled: false },
      { name: "read", label: "Read", enabled: false },
      { name: "write", label: "Write", enabled: false },
    ],
    external: [
      { name: "gmail", label: "Gmail", enabled: false },
      { name: "google", label: "Google", enabled: false },
    ],
    shellWarning: false,
  };
  return state;
}

function stateWithDisabledTools() {
  const state = withDisabledTools(stateWithTasks());
  state.sidebar.conversations[0].tasks = [];
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

  test("shows a Claude Code background subagent as an agent, not a shell command", () => {
    const state = stateWithTasks();
    state.sidebar.conversations[0].tasks = [
      { id: "agent-1", kind: "background", title: "JS engine core", startedAt: 1_000, toolName: "Agent" },
      { id: "shell-1", kind: "background", title: "npm test", startedAt: 2_000, toolName: "Bash" },
    ];
    const panel = renderTaskPanel(state, 100, 20, 43_000)!;
    const plain = panel.lines.map(stripAnsi);
    expect(plain[1]).toContain("◆ Agent JS engine core");
    expect(panel.lines[1]).toContain(hexToAnsi("#1122ee"));
    expect(plain[2]).toContain("$ Bash npm test");
  });

  test("names other Claude Code background work by what runs it, never as Bash", () => {
    const state = stateWithTasks();
    state.sidebar.conversations[0].tasks = [
      { id: "workflow-1", kind: "background", title: "Review changes", startedAt: 1_000, toolName: "Workflow" },
      { id: "monitor-1", kind: "background", title: "deploy errors", startedAt: 2_000, toolName: "Monitor" },
      { id: "mcp-1", kind: "background", title: "Export doc", startedAt: 3_000, toolName: "MCP" },
      { id: "bash:1", kind: "background", title: "bun test", startedAt: 4_000, toolName: "bash" },
    ];
    const panel = renderTaskPanel(state, 100, 20, 43_000)!;
    const plain = panel.lines.map(stripAnsi);
    expect(plain[1]).toContain("◆ Workflow Review changes");
    expect(panel.lines[1]).toContain(hexToAnsi("#1122ee"));
    expect(plain[2]).toContain("$ Monitor deploy errors");
    expect(plain[3]).toContain("$ MCP Export doc");
    expect(plain[4]).toContain("$ Bash bun test");
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
    expect(panel?.lines.map(stripAnsi).join("\n")).toContain("▸ 2 more");
    expect(panel?.lines.every(line => termWidth(stripAnsi(line)) === 32)).toBe(true);
  });

  test("caps very tall task cards and reports the hidden schedules", () => {
    const state = stateWithTasks();
    state.sidebar.conversations[0].tasks = Array.from({ length: 27 }, (_, index) => ({
      id: `chrono:${index}`,
      kind: "chrono" as const,
      title: `Schedule ${index}`,
      startedAt: 1_000,
      dueAt: 10 * 24 * 60 * 60_000,
      chronoMode: "wake" as const,
    }));

    const panel = renderTaskPanel(state, 100, 60, 0)!;
    expect(panel.lines).toHaveLength(MAX_TASK_PANEL_HEIGHT);
    expect(panel.lines.map(stripAnsi).join("\n")).toContain("▸ 18 more · click to expand");
  });

  test("is absent without focused tasks or enough room", () => {
    const state = stateWithTasks();
    state.sidebar.conversations[0].tasks = [];
    expect(renderTaskPanel(state, 100, 20)).toBeNull();
    state.sidebar.conversations[0].tasks = [{ id: "x", kind: "subagent", title: "One task", startedAt: 0 }];
    expect(renderTaskPanel(state, 29, 20)).toBeNull();
    expect(renderTaskPanel(state, 100, 2)).toBeNull();
  });

  test("reserves a readable history column and omits the float on narrow chats", () => {
    const state = stateWithTasks();

    const wide = layoutTaskPanel(state, 70, 20, 43_000);
    expect(wide.panel?.width).toBe(39);
    expect(wide.historyWidth).toBe(30);

    const narrow = layoutTaskPanel(state, 59, 20, 43_000);
    expect(narrow.panel).toBeNull();
    expect(narrow.historyWidth).toBe(59);
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

  test("shows a running Chrono occurrence's elapsed time on its schedule row", () => {
    const state = stateWithTasks();
    const running = {
      id: "chrono:monitor", kind: "chrono" as const, title: "Running: Monitor", startedAt: 60_000,
      dueAt: 60_000, chronoMode: "wake" as const, chronoRunning: true as const,
    };
    state.sidebar.conversations[0].tasks = [running];

    const plain = renderTaskPanel(state, 100, 20, 63_000)!.lines.map(stripAnsi).join("\n");
    expect(plain).toContain("Running: Monitor");
    expect(plain).toContain("3s");
    expect(plain).not.toContain("due");
    expect(msUntilTaskPanelEntryUpdate(running, 63_250)).toBe(750);
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

describe("focused conversation subscriptions", () => {
  test("selects integrations only from the focused conversation and keeps them separate from tasks", () => {
    const state = stateWithIntegrations();
    state.sidebar.conversations.push({
      ...state.sidebar.conversations[0],
      id: "other",
      title: "Other",
      integrations: [integration({ id: "integration:other", label: "Other source" })],
    });

    expect(focusedConversationIntegrations(state).map(item => item.id)).toEqual([
      "integration:discord:design",
      "integration:whatsapp:ops",
    ]);
    expect(hasFocusedConversationIntegrations(state)).toBe(true);
    expect(focusedConversationTasks(state)).toEqual([]);
    expect(hasFocusedConversationTasks(state)).toBe(false);

    state.convId = "other";
    expect(focusedConversationIntegrations(state).map(item => item.id)).toEqual(["integration:other"]);
    state.convId = null;
    expect(focusedConversationIntegrations(state)).toEqual([]);
    expect(hasFocusedConversationIntegrations(state)).toBe(false);
  });

  test("a conversation with only subscriptions shows a Subscriptions card and no Tasks card", () => {
    const state = stateWithIntegrations();
    expect(renderTaskPanel(state, 100, 20, 43_000)).toBeNull();
    const panel = renderSubscriptionsPanel(state, 100, 20);
    expect(panel).not.toBeNull();
    expect(panel?.width).toBe(50);
    expect(panel?.lines).toHaveLength(4);

    const plain = panel!.lines.map(stripAnsi);
    expect(plain[0]).toContain("Subscriptions");
    expect(plain[0].trimEnd()).toEndWith("2 ─╮");
    expect(plain.join("\n")).not.toContain("Tasks");
    expect(plain.join("\n").match(/Subscriptions/g)).toHaveLength(1);
    expect(plain[1]).toContain("Discord Design alerts");
    expect(plain[1]).toContain("wake active");
    expect(plain[2]).toContain("WhatsApp Ops room");
    expect(plain[2]).toContain("inbox offline");
    expect(plain.join("\n")).not.toContain("42s");
    expect(panel!.lines[1]).toContain(hexToAnsi("#5865f2"));
    expect(panel!.lines[2]).toContain(hexToAnsi("#25d366"));
    expect(panel!.lines.every(line => line.includes(hexToAnsiBg("#00050f")))).toBe(true);
    expect(panel!.lines.every(line => visibleLength(line) === panel!.width)).toBe(true);
  });

  test("tasks and subscriptions are separate cards, each counting its own entries", () => {
    const state = stateWithTasks();
    state.externalToolStyles = [{ cmd: "discord", label: "Discord", color: "#5865f2" }];
    state.sidebar.conversations[0].integrations = [integration(), integration({ id: "integration:two", label: "Deployments" })];

    const tasks = renderTaskPanel(state, 100, 20, 43_000)!.lines.map(stripAnsi);
    expect(tasks).toHaveLength(4);
    expect(tasks[0]).toMatch(/^╭─ Tasks ─+ 2 ─╮$/);
    expect(tasks[1]).toContain("◆ Exocortex Map daemon events");
    expect(tasks[2]).toContain("$ Bash bun test tui");
    expect(tasks.join("\n")).not.toContain("Subscriptions");
    expect(tasks.join("\n")).not.toContain("Design alerts");

    const subscriptions = renderSubscriptionsPanel(state, 100, 20)!.lines.map(stripAnsi);
    expect(subscriptions).toHaveLength(4);
    expect(subscriptions[0]).toMatch(/^╭─ Subscriptions ─+ 2 ─╮$/);
    expect(subscriptions[1]).toContain("Discord Design alerts");
    expect(subscriptions[1]).toContain("wake active");
    expect(subscriptions[2]).toContain("Discord Deployments");
  });

  test("keeps the Subscriptions card and its overflow correct at the 30-column minimum", () => {
    const state = stateWithIntegrations();
    state.externalToolStyles = [{ cmd: "discord", label: "An impossibly long tool label", color: "#5865f2" }];
    state.sidebar.conversations[0].integrations = [
      integration({ label: "A very long source label", delivery: "inbox", status: "disabled" }),
      integration({ id: "integration:two", label: "Second source" }),
      integration({ id: "integration:three", label: "Third source" }),
      integration({ id: "integration:four", label: "Fourth source" }),
    ];

    const panel = renderSubscriptionsPanel(state, 30, 5)!;
    const plain = panel.lines.map(stripAnsi);
    expect(panel.width).toBe(30);
    expect(panel.lines).toHaveLength(5);
    expect(plain[0]).toContain("Subscriptions");
    expect(plain[1]).toContain("inbox disabled");
    expect(plain[3]).toContain("▸ 2 more");
    expect(panel.toggleable).toBe(true);
    expect(panel.lines.every(line => termWidth(stripAnsi(line)) === 30)).toBe(true);
  });

  test("the column stacks Tasks, Subscriptions and Scratchpad, top to bottom", () => {
    const state = stateWithTasks();
    state.externalToolStyles = [{ cmd: "discord", label: "Discord", color: "#5865f2" }];
    state.sidebar.conversations[0].integrations = [integration()];
    state.sidebar.conversations[0].scratchpad = "pad";
    state.scratchpads.put("pad", "- [ ] Write the report\n- [x] Read the paper");

    const layout = layoutSidePanels(state, 120, 30, 43_000);
    const column = [...layout.panel!.lines, ...layout.subscriptions!.lines, ...layout.scratchpad!.lines].map(stripAnsi);
    const headers = column.filter(line => line.startsWith("╭"));
    expect(headers.map(line => line.match(/Tasks|Subscriptions|Scratchpad/)?.[0])).toEqual(["Tasks", "Subscriptions", "Scratchpad"]);
    expect(column).toHaveLength(4 + 3 + 4);
    expect(layout.column).toEqual({ width: 50, height: 11 });
    expect(layout.historyWidth).toBe(120 - 50 - 1);
  });

  test("a full Tasks card leaves room for the smallest Subscriptions and Scratchpad cards below it", () => {
    const state = stateWithTasks();
    state.sidebar.conversations[0].tasks = [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ id: `child-${n}`, kind: "subagent" as const, title: `Child ${n}`, startedAt: 1_000 + n }));
    state.sidebar.conversations[0].integrations = ["one", "two", "three"].map(id => integration({ id: `integration:${id}`, label: `Subscription ${id}` }));
    state.sidebar.conversations[0].scratchpad = "pad";
    state.scratchpads.put("pad", "a\nb\nc");

    // 12 rows: Subscriptions and Scratchpad each keep a row, an overflow row and borders (4 + 4), Tasks the 4 left.
    const layout = layoutSidePanels(state, 120, 12, 50_000);
    expect(layout.panel!.lines).toHaveLength(4);
    expect(stripAnsi(layout.panel!.lines[2])).toContain("▸ 7 more");
    expect(layout.subscriptions!.lines).toHaveLength(4);
    expect(stripAnsi(layout.subscriptions!.lines[0])).toMatch(/Subscriptions ─+ 3 ─╮$/);
    expect(layout.scratchpad!.lines).toHaveLength(4);
    expect(layout.column!.height).toBe(12);

    // Folded cards below take a row each, so Tasks gets the rest.
    toggleCardFold(state, "subscriptions");
    toggleCardFold(state, "scratchpad");
    const folded = layoutSidePanels(state, 120, 12, 50_000);
    expect(folded.panel!.lines).toHaveLength(10);
    expect(folded.subscriptions!.lines).toHaveLength(1);
    expect(folded.scratchpad!.lines).toHaveLength(1);
  });

  test("Shift-folding a card leaves just its header, with its count", () => {
    const state = stateWithTasks();
    state.sidebar.conversations[0].integrations = [integration()];
    toggleCardFold(state, "tasks");
    const tasks = renderTaskPanel(state, 100, 20, 43_000)!;
    expect(tasks.lines.map(stripAnsi)).toEqual([expect.stringMatching(/^╶─ Tasks ─+ 2 ─╴$/)]);
    expect(tasks.width).toBe(50);
    expect(tasks.toggleable).toBe(false);
    expect(tasks.links).toEqual([]);
    expect(renderSubscriptionsPanel(state, 100, 20)!.lines).toHaveLength(3);

    // Folding an expanded card collapses it; unfolding brings back the capped card.
    toggleCardFold(state, "tasks");
    toggleTaskPanelExpansion(state);
    toggleCardFold(state, "tasks");
    expect(state.taskPanelExpansion).toBeNull();
    toggleCardFold(state, "tasks");
    expect(renderTaskPanel(state, 100, 20, 43_000)!.lines).toHaveLength(4);
  });

  test("at most one card of the column is expanded", () => {
    const state = stateWithTasks();
    state.sidebar.conversations[0].integrations = [integration()];
    toggleTaskPanelExpansion(state);
    toggleSubscriptionsExpansion(state);
    expect(state.taskPanelExpansion).toBeNull();
    expect(state.subscriptionsExpansion).toEqual({ convId: "parent", scroll: 0 });
    toggleTaskPanelExpansion(state);
    expect(state.subscriptionsExpansion).toBeNull();
  });

  test("lists subagents first, ahead of the daemon's shell and Chrono order, collapsed and expanded", () => {
    const state = stateWithTasks();
    state.sidebar.conversations[0].tasks = [
      { id: "bash:1", kind: "background", title: "bun test tui", startedAt: 1_000 },
      { id: "child", kind: "subagent", title: "Map daemon events", startedAt: 2_000 },
      { id: "chrono:1", kind: "chrono", title: "Hourly review", startedAt: 1_000, dueAt: 90_000, chronoMode: "wake" },
    ];
    const order = (lines: string[]) => lines.map(stripAnsi)
      .map(line => line.match(/Map daemon events|bun test tui|Hourly review/)?.[0])
      .filter(Boolean);
    expect(order(renderTaskPanel(state, 100, 20, 50_000)!.lines)).toEqual(["Map daemon events", "bun test tui", "Hourly review"]);
    toggleTaskPanelExpansion(state);
    expect(order(renderTaskPanel(state, 100, 20, 50_000)!.lines)).toEqual(["Map daemon events", "bun test tui", "Hourly review"]);
  });

  test("falls back to the manifest name and generic tool color when no external style is available", () => {
    const state = stateWithIntegrations();
    state.externalToolStyles = [];
    state.sidebar.conversations[0].integrations = [integration({ toolName: "custom-feed" })];

    const panel = renderSubscriptionsPanel(state, 100, 20)!;
    expect(stripAnsi(panel.lines[1])).toContain("custom-feed Design alerts");
    expect(panel.lines[1]).toContain(theme.tool);
  });
});

describe("focused conversation disabled tools", () => {
  test("never renders an old disabled-tools section", () => {
    const state = stateWithDisabledTools();
    expect(renderTaskPanel(state, 100, 20)).toBeNull();
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

  test("refreshes task labels only at the precision they display", () => {
    expect(msUntilTaskPanelEntryUpdate({
      id: "subagent",
      kind: "subagent",
      title: "Recent",
      startedAt: 1_000,
    }, 43_250)).toBe(750);
    expect(msUntilTaskPanelEntryUpdate({
      id: "background",
      kind: "background",
      title: "Hours old",
      startedAt: 0,
    }, 3 * 60 * 60_000 + 15_250)).toBe(44_750);
    expect(msUntilTaskPanelEntryUpdate({
      id: "chrono",
      kind: "chrono",
      title: "Tomorrow",
      startedAt: 0,
      dueAt: 25 * 60 * 60_000 + 15_250,
      chronoMode: "wake",
    }, 0)).toBe(60 * 60_000 + 15_250);
    expect(msUntilTaskPanelEntryUpdate({
      id: "due",
      kind: "chrono",
      title: "Due",
      startedAt: 0,
      dueAt: 1_000,
      chronoMode: "wake",
    }, 1_000)).toBeNull();
    expect(msUntilTaskPanelEntryUpdate({
      id: "paused",
      kind: "goal",
      title: "Paused",
      startedAt: 0,
      goalStatus: "paused",
    }, 1_000)).toBeNull();
  });

  test("formats integration delivery and health compactly", () => {
    expect(formatIntegrationDeliveryStatus({ delivery: "wake", status: "active" })).toBe("wake active");
    expect(formatIntegrationDeliveryStatus({ delivery: "inbox", status: "disabled" })).toBe("inbox disabled");
    expect(formatIntegrationDeliveryStatus({ delivery: "soft", status: "active" })).toBe("soft active");
  });

  describe("subagent rows mirror the child conversation's sidebar indicator", () => {
    const exo = hexToAnsi("#1122ee");

    function withChild(overrides: Record<string, unknown>) {
      const state = stateWithTasks();
      const parent = state.sidebar.conversations[0];
      state.sidebar.conversations.push({ ...parent, id: "child", title: "Child", tasks: [], ...overrides } as typeof parent);
      return state;
    }

    function subagentLine(state: ReturnType<typeof stateWithTasks>, width = 100): string {
      const panel = renderTaskPanel(state, width, 20, 43_000)!;
      return panel.lines[1];
    }

    /** Colour sequence directly preceding the row's first glyph, and the glyph itself. */
    function glyph(line: string): { color: string; char: string } {
      const match = line.match(/(\x1b\[[0-9;]*m)([◉◆])/);
      return { color: match![1], char: match![2] };
    }

    test("streaming child shows the blue sidebar indicator and keeps the Exocortex label colour", () => {
      const line = subagentLine(withChild({ streaming: true }));
      expect(glyph(line)).toEqual({ color: theme.accent, char: "◉" });
      expect(stripAnsi(line)).toContain("◉ Exocortex Map daemon events");
      expect(line).toContain(`${exo} Exocortex`);
    });

    test("child suspended in a durable sleep is yellow", () => {
      const sleep = { id: "chrono:sleep:1", kind: "chrono", title: "sleep", startedAt: 1_000, dueAt: 9_000_000, chronoMode: "sleep" };
      const line = subagentLine(withChild({ streaming: false, tasks: [sleep] }));
      expect(glyph(line)).toEqual({ color: theme.warning, char: "◉" });
    });

    test("child sleeping inside a streaming turn is yellow, not blue", () => {
      const sleep = { id: "chrono:sleep:1", kind: "chrono", title: "sleep", startedAt: 1_000, dueAt: 9_000_000, chronoMode: "sleep" };
      const line = subagentLine(withChild({ streaming: true, tasks: [sleep] }));
      expect(glyph(line).color).toBe(theme.warning);
    });

    test("child with a message queued for global idle is yellow", () => {
      const state = withChild({ streaming: false });
      state.queuedMessages = [{ convId: "child", text: "go", timing: "global-idle", source: "global-idle" } as never];
      expect(glyph(subagentLine(state))).toEqual({ color: theme.warning, char: "◉" });
    });

    test("unread child is green unless its notifications are muted", () => {
      expect(glyph(subagentLine(withChild({ unread: true })))).toEqual({ color: theme.success, char: "◉" });
      const muted = glyph(subagentLine(withChild({ unread: true, muted: true })));
      expect(muted).toEqual({ color: exo, char: "◆" });
    });

    test("idle or unknown child keeps the static diamond in the Exocortex colour", () => {
      expect(glyph(subagentLine(withChild({})))).toEqual({ color: exo, char: "◆" });
      expect(glyph(subagentLine(stateWithTasks()))).toEqual({ color: exo, char: "◆" });
    });

    test("compact and wide cards use the same glyph and align with other rows", () => {
      const state = withChild({ streaming: true });
      for (const width of [100, 36]) {
        const panel = renderTaskPanel(state, width, 20, 43_000)!;
        expect(stripAnsi(panel.lines[1])).toContain(width === 100 ? "◉ Exocortex" : "◉ Exo ");
        expect(panel.lines.every(line => visibleLength(line) === panel.width)).toBe(true);
      }
    });

    test("other task kinds are untouched while a subagent is streaming", () => {
      const panel = renderTaskPanel(withChild({ streaming: true }), 100, 20, 43_000)!;
      expect(stripAnsi(panel.lines[2])).toContain("$ Bash bun test tui");
    });

    test("uses the same glyph and colour as the child's sidebar row", () => {
      const sleep = { id: "chrono:sleep:1", kind: "chrono", title: "sleep", startedAt: 1_000, dueAt: 9_000_000, chronoMode: "sleep" };
      for (const overrides of [{ streaming: true }, { tasks: [sleep] }, { unread: true }]) {
        const state = withChild(overrides);
        const sidebarRows = renderSidebar(state.sidebar, 20, false, "parent");
        const childRow = sidebarRows.find(row => stripAnsi(row).includes("Child"))!;
        const sidebarGlyph = childRow.match(/(\x1b\[[0-9;]*m)◉/)![1];
        expect(glyph(subagentLine(state)).color).toBe(sidebarGlyph);
      }
    });
  });
});
