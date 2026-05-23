#!/usr/bin/env bun
import { buildMessageLines } from "../../tui/src/conversation";
import { render } from "../../tui/src/render";
import { createInitialState, type RenderState } from "../../tui/src/state";
import { createSidebarState } from "../../tui/src/sidebar/state";
import { handleSidebarAction, renderSidebar, updateConversationList } from "../../tui/src/sidebar";
import { buildDisplayRows } from "../../tui/src/sidebar/rows";
import type { Block, ConversationSummary, FolderSummary, Message } from "../../tui/src/messages";

interface SampleSummary {
  minMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

interface MetricReport extends SampleSummary {
  axis: string;
  workload: string;
  iterations: number;
  warmups: number;
  digest: number;
}

interface BenchmarkReport {
  benchmark: "exocortex-performance-autoresearch";
  version: 1;
  generatedAt: string;
  runtime: {
    bun: string;
    platform: string;
    arch: string;
  };
  criteria: {
    maxAllowedP95RegressionRatio: number;
    minTargetP95ImprovementRatio: number;
    minGeomeanP95ImprovementRatio: number;
  };
  metrics: MetricReport[];
  compare?: CompareReport;
}

interface CompareReport {
  baselinePath: string;
  passed: boolean;
  p95GeomeanRatio: number;
  largestRegression?: MetricComparison;
  largestImprovement?: MetricComparison;
  regressions: MetricComparison[];
  improvements: MetricComparison[];
  notes: string[];
}

interface MetricComparison {
  key: string;
  baselineP95Ms: number;
  currentP95Ms: number;
  ratio: number;
  percent: number;
}

interface Options {
  json: boolean;
  comparePath: string | null;
}

const CRITERIA = {
  maxAllowedP95RegressionRatio: 1.02,
  minTargetP95ImprovementRatio: 0.95,
  minGeomeanP95ImprovementRatio: 0.98,
} as const;

let blackhole = 0;

function parseOptions(argv: string[]): Options {
  const options: Options = { json: false, comparePath: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--compare") options.comparePath = argv[++i] ?? null;
    else if (arg.startsWith("--compare=")) options.comparePath = arg.slice("--compare=".length);
    else if (arg === "-h" || arg === "--help") {
      console.log(`Usage: bun run autoresearch/exocortex-performance/benchmark.ts [--json] [--compare result.json]\n\nRuns deterministic Exocortex TUI performance axes and optionally compares p95s with a previous JSON report.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[idx];
}

function summarize(samples: number[]): SampleSummary {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    minMs: sorted[0] ?? 0,
    avgMs: samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length),
    p50Ms: percentile(sorted, 0.50),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function finalizeMetric(axis: string, workload: string, iterations: number, warmups: number, samples: number[], digest: number): MetricReport {
  const s = summarize(samples);
  return {
    axis,
    workload,
    iterations,
    warmups,
    minMs: round(s.minMs),
    avgMs: round(s.avgMs),
    p50Ms: round(s.p50Ms),
    p95Ms: round(s.p95Ms),
    maxMs: round(s.maxMs),
    digest,
  };
}

function measureMetric(
  axis: string,
  workload: string,
  iterations: number,
  warmups: number,
  fn: (iteration: number) => number,
): MetricReport {
  for (let i = 0; i < warmups; i++) blackhole ^= fn(-warmups + i) | 0;
  const samples: number[] = [];
  let digest = 0;
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    digest = (digest + fn(i)) | 0;
    const t1 = performance.now();
    samples.push(t1 - t0);
  }
  blackhole ^= digest;
  return finalizeMetric(axis, workload, iterations, warmups, samples, digest);
}

function withCapturedStdout<T>(fn: () => T): { value: T; bytes: number } {
  const origWrite = process.stdout.write.bind(process.stdout);
  let bytes = 0;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    bytes += typeof chunk === "string" ? chunk.length : chunk.byteLength;
    return true;
  }) as typeof process.stdout.write;
  try {
    return { value: fn(), bytes };
  } finally {
    process.stdout.write = origWrite as typeof process.stdout.write;
  }
}

function markdownBlock(i: number, repeat: number): string {
  return [
    `# Section ${i}`,
    "",
    "This answer mixes **bold**, *italic*, `inline code`, emoji 🧠, and prose so markdown and width code stay hot.",
    "",
    "| metric | value | note |",
    "| --- | ---: | --- |",
    `| p95 | ${i % 97} | deterministic table row |`,
    "",
    "```ts",
    `export function sample${i}(input: number): number {`,
    "  return input * 2 + 1;",
    "}",
    "```",
    "",
    ("Long paragraph content that wraps across terminal rows and resembles real assistant output. ").repeat(repeat),
  ].join("\n");
}

function toolOutput(i: number, lines: number): string {
  const out: string[] = [];
  for (let j = 0; j < lines; j++) {
    out.push(`line ${i}.${j}: deterministic command output with paths /tmp/project/${i}/${j} and values ${i * 17 + j}`);
  }
  return out.join("\n");
}

function makeMessages(turns: number, repeat: number, toolEvery: number, toolLines: number): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < turns; i++) {
    messages.push({
      role: "user",
      text: `User request ${i}: make the app faster while preserving exact UX. ${(i % 5 === 0 ? "Include a longer user sentence to exercise bubble wrapping. " : "").repeat(2)}`,
      metadata: null,
    });

    const blocks: Block[] = [];
    if (i % 11 === 0) blocks.push({ type: "thinking", text: `Considering profile ${i}. `.repeat(Math.max(1, Math.floor(repeat / 2))) });
    blocks.push({ type: "text", text: markdownBlock(i, repeat) });
    if (toolEvery > 0 && i % toolEvery === 0) {
      const toolCallId = `tool-${i}`;
      blocks.push({
        type: "tool_call",
        toolCallId,
        toolName: "functions.bash",
        summary: `Run deterministic command ${i} with enough arguments to wrap across sidebar-sized widths --flag=${i}`,
      });
      blocks.push({
        type: "tool_result",
        toolCallId,
        toolName: "functions.bash",
        output: toolOutput(i, toolLines),
        isError: i % 13 === 0,
      });
    }
    messages.push({
      role: "assistant",
      blocks,
      metadata: {
        startedAt: 1_700_000_000_000 + i * 1000,
        endedAt: 1_700_000_000_500 + i * 1000,
        model: "gpt-5.1",
        tokens: 250 + i,
      },
    });
  }
  return messages;
}

function makeState(messages: Message[], showToolOutput: boolean, convId: string): RenderState {
  const state = createInitialState();
  state.cols = 140;
  state.rows = 44;
  state.convId = convId;
  state.messages = messages;
  state.showToolOutput = showToolOutput;
  state.inputBuffer = "";
  state.cursorPos = 0;
  state.sidebar.conversations = makeConversations(50, 0).conversations;
  state.sidebar.folders = [];
  return state;
}

function renderFrameDigest(state: RenderState): number {
  const captured = withCapturedStdout(() => render(state));
  return captured.bytes + state.historyLines.length + state.layout.totalLines;
}

const conversationWorkloads = [
  { name: "small_chat", turns: 8, repeat: 1, toolEvery: 0, toolLines: 0, iterationsCold: 45, iterationsWarm: 90, showToolOutput: false },
  { name: "medium_markdown", turns: 180, repeat: 3, toolEvery: 17, toolLines: 8, iterationsCold: 12, iterationsWarm: 45, showToolOutput: false },
  { name: "huge_markdown_collapsed_tools", turns: 900, repeat: 5, toolEvery: 9, toolLines: 35, iterationsCold: 4, iterationsWarm: 20, showToolOutput: false },
  { name: "huge_expanded_tools", turns: 280, repeat: 4, toolEvery: 3, toolLines: 80, iterationsCold: 3, iterationsWarm: 12, showToolOutput: true },
] as const;

function runConversationBenchmarks(): MetricReport[] {
  const reports: MetricReport[] = [];
  for (const workload of conversationWorkloads) {
    reports.push(measureMetric(
      "conversation_open_cold",
      workload.name,
      workload.iterationsCold,
      1,
      (iteration) => {
        const messages = makeMessages(workload.turns, workload.repeat, workload.toolEvery, workload.toolLines);
        const state = makeState(messages, workload.showToolOutput, `${workload.name}-cold-${iteration}`);
        return renderFrameDigest(state);
      },
    ));

    const warmMessages = makeMessages(workload.turns, workload.repeat, workload.toolEvery, workload.toolLines);
    const warmState = makeState(warmMessages, workload.showToolOutput, `${workload.name}-warm`);
    renderFrameDigest(warmState);
    reports.push(measureMetric(
      "conversation_open_warm",
      workload.name,
      workload.iterationsWarm,
      3,
      (iteration) => {
        warmState.inputBuffer = iteration % 2 === 0 ? "" : "x";
        warmState.cursorPos = warmState.inputBuffer.length;
        return renderFrameDigest(warmState);
      },
    ));

    reports.push(measureMetric(
      "conversation_build_lines_cold",
      workload.name,
      Math.max(3, workload.iterationsCold),
      1,
      (iteration) => {
        const state = makeState(
          makeMessages(workload.turns, workload.repeat, workload.toolEvery, workload.toolLines),
          workload.showToolOutput,
          `${workload.name}-lines-${iteration}`,
        );
        const result = buildMessageLines(state, state.cols);
        return result.lines.length + result.messageBounds.length + result.lineAnchors.length;
      },
    ));
  }
  return reports;
}

function makeConversations(count: number, folderCount: number): { conversations: ConversationSummary[]; folders: FolderSummary[] } {
  const folders: FolderSummary[] = [];
  for (let i = 0; i < folderCount; i++) {
    folders.push({
      id: `folder-${i}`,
      name: `Folder ${i} ${(i % 7 === 0 ? "Performance" : "Archive")}`,
      parentId: i > 0 && i % 5 === 0 ? `folder-${Math.floor((i - 1) / 5)}` : null,
      createdAt: 1_700_000_000_000 - i * 1000,
      updatedAt: 1_700_500_000_000 - i * 777,
      pinned: i % 11 === 0,
      sortOrder: i,
      effectiveInstructions: i % 3 === 0 ? "Keep changes invisible to users." : undefined,
    });
  }

  const conversations: ConversationSummary[] = [];
  for (let i = 0; i < count; i++) {
    conversations.push({
      id: `conv-${i}`,
      provider: "openai",
      model: "gpt-5.1",
      effort: i % 2 === 0 ? "low" : "medium",
      fastMode: i % 3 === 0,
      createdAt: 1_700_000_000_000 - i * 1000,
      updatedAt: 1_701_000_000_000 - i * 131,
      messageCount: 2 + (i % 1000),
      title: `${i % 17 === 0 ? "🚀 " : ""}${i % 19 === 0 ? "Performance investigation" : "Conversation"} ${i} ${"responsive sidebar ".repeat(i % 4)}`,
      goal: null,
      marked: i % 41 === 0,
      pinned: i % 29 === 0,
      streaming: i % 101 === 0,
      unread: i % 73 === 0,
      sortOrder: i,
      folderId: folderCount > 0 && i % 4 !== 0 ? `folder-${i % folderCount}` : null,
    });
  }
  return { conversations, folders };
}

function makeSidebar(conversationCount: number, folderCount: number, mode: "root" | "folder" | "search" | "visual") {
  const sidebar = createSidebarState();
  const data = makeConversations(conversationCount, folderCount);
  sidebar.conversations = data.conversations;
  sidebar.folders = data.folders;
  sidebar.selectedItem = { type: "conversation", id: sidebar.conversations[0]?.id ?? "" };
  sidebar.selectedId = sidebar.conversations[0]?.id ?? null;
  sidebar.selectedIndex = 0;
  if (mode === "folder" && folderCount > 0) sidebar.currentFolderId = "folder-0";
  if (mode === "search") {
    sidebar.search = {
      barOpen: true,
      barMode: "search",
      direction: "forward",
      query: "",
      barInput: "performance",
      barCursorPos: "performance".length,
      highlightsVisible: true,
      savedSelectedId: sidebar.selectedId,
      savedSelectedIndex: sidebar.selectedIndex,
      savedSelectedItem: sidebar.selectedItem,
      savedScrollOffset: sidebar.scrollOffset,
    };
  }
  if (mode === "visual") {
    sidebar.visualAnchor = { type: "conversation", id: sidebar.conversations[Math.min(400, sidebar.conversations.length - 1)]?.id ?? "conv-0" };
  }
  return sidebar;
}

const sidebarWorkloads = [
  { name: "small_root", conversations: 120, folders: 8, rows: 34 as const },
  { name: "large_root", conversations: 5_000, folders: 300, rows: 42 as const },
  { name: "huge_foldered", conversations: 18_000, folders: 1_200, rows: 48 as const },
] as const;

function runSidebarBenchmarks(): MetricReport[] {
  const reports: MetricReport[] = [];
  for (const workload of sidebarWorkloads) {
    reports.push(measureMetric(
      "sidebar_render",
      `${workload.name}.root`,
      workload.name === "huge_foldered" ? 12 : workload.name === "large_root" ? 28 : 80,
      3,
      (() => {
        const sidebar = makeSidebar(workload.conversations, workload.folders, "root");
        return (iteration: number) => {
          sidebar.scrollOffset = Math.max(0, iteration % Math.max(1, workload.conversations - workload.rows));
          const rows = renderSidebar(sidebar, workload.rows, iteration % 2 === 0, sidebar.conversations[iteration % sidebar.conversations.length]?.id ?? null);
          return rows.length + rows.join("\n").length;
        };
      })(),
    ));

    reports.push(measureMetric(
      "sidebar_navigation",
      `${workload.name}.nav_down`,
      workload.name === "huge_foldered" ? 80 : workload.name === "large_root" ? 160 : 300,
      5,
      (() => {
        const sidebar = makeSidebar(workload.conversations, workload.folders, "root");
        return () => {
          handleSidebarAction("nav_down", sidebar);
          return sidebar.selectedIndex + (sidebar.selectedId?.length ?? 0);
        };
      })(),
    ));

    reports.push(measureMetric(
      "sidebar_search_filter",
      `${workload.name}.performance_query`,
      workload.name === "huge_foldered" ? 18 : workload.name === "large_root" ? 35 : 80,
      3,
      (() => {
        const sidebar = makeSidebar(workload.conversations, workload.folders, "search");
        return (iteration: number) => {
          sidebar.search!.barInput = iteration % 2 === 0 ? "performance" : "conversation";
          const displayRows = buildDisplayRows(sidebar);
          const rows = renderSidebar(sidebar, workload.rows, true, null);
          return displayRows.length + rows.length;
        };
      })(),
    ));

    reports.push(measureMetric(
      "sidebar_list_update",
      `${workload.name}.replace_and_sync`,
      workload.name === "huge_foldered" ? 10 : workload.name === "large_root" ? 20 : 60,
      2,
      (iteration) => {
        const sidebar = makeSidebar(0, 0, "root");
        const data = makeConversations(workload.conversations, workload.folders);
        if (iteration % 2 === 0 && data.conversations[10]) sidebar.pendingFocusItem = { type: "conversation", id: data.conversations[10].id };
        updateConversationList(sidebar, data.conversations, data.folders);
        return sidebar.conversations.length + sidebar.folders.length + (sidebar.selectedId?.length ?? 0);
      },
    ));
  }

  reports.push(measureMetric(
    "sidebar_render",
    "large_root.visual_selection",
    20,
    3,
    (() => {
      const sidebar = makeSidebar(5_000, 300, "visual");
      return (iteration: number) => {
        sidebar.scrollOffset = iteration * 3;
        const rows = renderSidebar(sidebar, 42, true, "conv-42");
        return rows.length + rows.join("\n").length;
      };
    })(),
  ));

  return reports;
}

function keyFor(metric: Pick<MetricReport, "axis" | "workload">): string {
  return `${metric.axis}/${metric.workload}`;
}

function compareReports(current: BenchmarkReport, baseline: BenchmarkReport, baselinePath: string): CompareReport {
  const baseMap = new Map(baseline.metrics.map(metric => [keyFor(metric), metric]));
  const comparisons: MetricComparison[] = [];
  const notes: string[] = [];

  for (const metric of current.metrics) {
    const base = baseMap.get(keyFor(metric));
    if (!base) {
      notes.push(`No baseline metric for ${keyFor(metric)}`);
      continue;
    }
    const ratio = metric.p95Ms / Math.max(0.001, base.p95Ms);
    comparisons.push({
      key: keyFor(metric),
      baselineP95Ms: base.p95Ms,
      currentP95Ms: metric.p95Ms,
      ratio: round(ratio),
      percent: round((ratio - 1) * 100),
    });
  }

  const matched = comparisons.filter(c => c.baselineP95Ms > 0 && c.currentP95Ms > 0);
  const p95GeomeanRatio = matched.length === 0
    ? 1
    : Math.exp(matched.reduce((sum, c) => sum + Math.log(c.currentP95Ms / c.baselineP95Ms), 0) / matched.length);
  const regressions = comparisons.filter(c => c.currentP95Ms / c.baselineP95Ms > CRITERIA.maxAllowedP95RegressionRatio);
  const improvements = comparisons.filter(c => c.currentP95Ms / c.baselineP95Ms <= CRITERIA.minTargetP95ImprovementRatio);
  const largestRegression = [...comparisons].sort((a, b) => b.ratio - a.ratio)[0];
  const largestImprovement = [...comparisons].sort((a, b) => a.ratio - b.ratio)[0];
  const passed = regressions.length === 0 && (improvements.length > 0 || p95GeomeanRatio <= CRITERIA.minGeomeanP95ImprovementRatio);

  if (regressions.length > 0) notes.push(`${regressions.length} p95 regression(s) exceed ${(CRITERIA.maxAllowedP95RegressionRatio - 1) * 100}%`);
  if (improvements.length === 0 && p95GeomeanRatio > CRITERIA.minGeomeanP95ImprovementRatio) notes.push("No targeted p95 improvement >= 5% and geomean p95 improvement < 2%.");

  return {
    baselinePath,
    passed,
    p95GeomeanRatio: round(p95GeomeanRatio),
    largestRegression,
    largestImprovement,
    regressions,
    improvements,
    notes,
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const metrics = [
    ...runConversationBenchmarks(),
    ...runSidebarBenchmarks(),
  ];
  const report: BenchmarkReport = {
    benchmark: "exocortex-performance-autoresearch",
    version: 1,
    generatedAt: new Date().toISOString(),
    runtime: {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
    },
    criteria: { ...CRITERIA },
    metrics,
  };

  if (options.comparePath) {
    const baseline = await Bun.file(options.comparePath).json() as BenchmarkReport;
    report.compare = compareReports(report, baseline, options.comparePath);
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("Exocortex performance autoresearch benchmark");
    console.log(`blackhole=${blackhole}`);
    for (const metric of report.metrics) {
      console.log(`${metric.axis.padEnd(30)} ${metric.workload.padEnd(34)} p50=${metric.p50Ms.toFixed(3)}ms p95=${metric.p95Ms.toFixed(3)}ms avg=${metric.avgMs.toFixed(3)}ms`);
    }
    if (report.compare) {
      console.log(`compare passed=${report.compare.passed} geomean=${report.compare.p95GeomeanRatio}`);
      for (const note of report.compare.notes) console.log(`note: ${note}`);
    }
  }

  if (report.compare && !report.compare.passed) process.exitCode = 2;
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
