import { computeBottomLayout } from "../src/chatlayout";
import { buildMessageLines } from "../src/conversation";
import { createPendingAI } from "../src/messages";
import { render } from "../src/render";
import { createInitialState, type RenderState } from "../src/state";

interface SampleSummary {
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  avgBytes: number;
  maxBytes: number;
}

interface ScenarioReport {
  name: string;
  description: string;
  frames: number;
  historyTurns: number;
  summary: SampleSummary;
  notes: string[];
}

interface RenderCapture {
  ms: number;
  bytes: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx];
}

function summarize(samples: RenderCapture[]): SampleSummary {
  const times = samples.map(sample => sample.ms).sort((a, b) => a - b);
  const bytes = samples.map(sample => sample.bytes);
  return {
    avgMs: samples.reduce((sum, sample) => sum + sample.ms, 0) / samples.length,
    p50Ms: percentile(times, 0.5),
    p95Ms: percentile(times, 0.95),
    maxMs: Math.max(...times),
    avgBytes: bytes.reduce((sum, value) => sum + value, 0) / bytes.length,
    maxBytes: Math.max(...bytes),
  };
}

function captureRender(state: RenderState): RenderCapture {
  const origWrite = process.stdout.write.bind(process.stdout);
  let bytes = 0;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    bytes += typeof chunk === "string" ? chunk.length : chunk.byteLength;
    return true;
  }) as typeof process.stdout.write;

  try {
    const t0 = performance.now();
    render(state);
    const t1 = performance.now();
    return { ms: t1 - t0, bytes };
  } finally {
    process.stdout.write = origWrite as typeof process.stdout.write;
  }
}

function warmRenderCaches(state: RenderState): void {
  captureRender(state);
}

function buildMarkdownBlock(i: number, repeat: number): { type: "text"; text: string } {
  return {
    type: "text",
    text: [
      `# Heading ${i}`,
      "",
      "This paragraph mixes **bold**, *italic*, and `inline code` so markdown formatting stays hot.",
      "",
      "| col-a | col-b |",
      "| --- | --- |",
      `| ${i} | ${i + 1} |`,
      "",
      "```ts",
      `function example${i}(value: number): number {`,
      "  return value * 2;",
      "}",
      "```",
      "",
      ("Longer paragraph text that forces wrapping across multiple visual rows. ").repeat(repeat),
    ].join("\n"),
  };
}

function populateHistory(state: RenderState, turns: number, repeat = 4): void {
  for (let i = 0; i < turns; i++) {
    state.messages.push({
      role: "user",
      text: `User question ${i}: explain why terminal UIs flicker under load and what can be cached.`,
      metadata: null,
    });
    state.messages.push({
      role: "assistant",
      blocks: [buildMarkdownBlock(i, repeat)],
      metadata: null,
    });
  }
}

function createBaseState(turns: number, repeat = 4): RenderState {
  const state = createInitialState();
  state.cols = 120;
  state.rows = 40;
  populateHistory(state, turns, repeat);
  return state;
}

function profilePromptTyping(): ScenarioReport {
  const historyTurns = 500;
  const frames = 200;

  const bottomState = createBaseState(historyTurns, 4);
  warmRenderCaches(bottomState);
  const bottomLayoutSamples: number[] = [];
  for (let i = 0; i < frames; i++) {
    bottomState.inputBuffer = `typed frame ${i} /model openai custom-model-name`;
    bottomState.cursorPos = bottomState.inputBuffer.length;
    const bottomStart = performance.now();
    computeBottomLayout(bottomState, bottomState.cols, bottomState.rows);
    bottomLayoutSamples.push(performance.now() - bottomStart);
  }

  const historyState = createBaseState(historyTurns, 4);
  warmRenderCaches(historyState);
  const historySamples: number[] = [];
  for (let i = 0; i < frames; i++) {
    historyState.inputBuffer = `typed frame ${i} /model openai custom-model-name`;
    historyState.cursorPos = historyState.inputBuffer.length;
    const historyStart = performance.now();
    buildMessageLines(historyState, historyState.cols);
    historySamples.push(performance.now() - historyStart);
  }

  const renderState = createBaseState(historyTurns, 4);
  warmRenderCaches(renderState);
  const renderSamples: RenderCapture[] = [];
  for (let i = 0; i < frames; i++) {
    renderState.inputBuffer = `typed frame ${i} /model openai custom-model-name`;
    renderState.cursorPos = renderState.inputBuffer.length;
    renderSamples.push(captureRender(renderState));
  }

  const bottomSorted = [...bottomLayoutSamples].sort((a, b) => a - b);
  const historySorted = [...historySamples].sort((a, b) => a - b);

  return {
    name: "prompt_typing",
    description: "Warm-cache prompt typing with a large existing conversation.",
    frames,
    historyTurns,
    summary: summarize(renderSamples),
    notes: [
      `computeBottomLayout avg ${avg(bottomLayoutSamples).toFixed(3)}ms (p95 ${percentile(bottomSorted, 0.95).toFixed(3)}ms)`,
      `buildMessageLines avg ${avg(historySamples).toFixed(3)}ms (p95 ${percentile(historySorted, 0.95).toFixed(3)}ms)`,
      "Only the prompt/cursor changed, but the full message history was rebuilt every frame.",
    ],
  };
}

function createStreamingState(historyTurns: number): RenderState {
  const state = createBaseState(historyTurns, 3);
  state.pendingAI = createPendingAI(Date.now(), state.model);
  state.pendingAI.blocks.push({ type: "text", text: "" });
  warmRenderCaches(state);
  return state;
}

function profileStreaming(): ScenarioReport {
  const historyTurns = 100;
  const frames = 200;

  const historyState = createStreamingState(historyTurns);
  const historySamples: number[] = [];
  for (let i = 0; i < frames; i++) {
    (historyState.pendingAI!.blocks[0] as { type: "text"; text: string }).text += (
      `Chunk ${i}: streaming **markdown** content with tables, lists, and enough text to keep wrapping work proportional to the full live block. `
    ).repeat(2);
    const historyStart = performance.now();
    buildMessageLines(historyState, historyState.cols);
    historySamples.push(performance.now() - historyStart);
  }

  const renderState = createStreamingState(historyTurns);
  const renderSamples: RenderCapture[] = [];
  for (let i = 0; i < frames; i++) {
    (renderState.pendingAI!.blocks[0] as { type: "text"; text: string }).text += (
      `Chunk ${i}: streaming **markdown** content with tables, lists, and enough text to keep wrapping work proportional to the full live block. `
    ).repeat(2);
    renderSamples.push(captureRender(renderState));
  }

  const historySorted = [...historySamples].sort((a, b) => a - b);
  const last20 = renderSamples.slice(-20);

  return {
    name: "streaming_chunks",
    description: "Growing live assistant markdown block while streaming chunks.",
    frames,
    historyTurns,
    summary: summarize(renderSamples),
    notes: [
      `buildMessageLines avg ${avg(historySamples).toFixed(3)}ms (p95 ${percentile(historySorted, 0.95).toFixed(3)}ms)`,
      `last 20 frames avg ${avg(last20.map(sample => sample.ms)).toFixed(3)}ms`,
      "The pending live text block misses the block cache every chunk because its content changes.",
    ],
  };
}

function avg(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

const reports = [profilePromptTyping(), profileStreaming()];
console.log(JSON.stringify({ reports }, null, 2));
