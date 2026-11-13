import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { handleEvent } from "./events";
import { handleFocusedKey } from "./focus";
import { parseInput } from "./input";
import { resolveAction } from "./keybinds";
import type { ConversationSummary, EffortLevel, ModelId, ProviderInfo } from "./messages";
import {
  LADDER_MIN_STEP_MS,
  MODEL_LADDER,
  latestFamilyModel,
  ladderStep,
  modelLadderFrameDelay,
  pressModelLadder,
  queuedModel,
  setLadderAnimationsForTest,
  type LadderDaemon,
} from "./modelladder";
import { LADDER_LATE_FRAME_MS, METER_FADE_MS, METER_HOLD_MS, MORPH_TOTAL_MS, WAIT_FRAME_MS } from "./modelladder-anim";
import { createInitialState, type RenderState } from "./state";
import { renderTopbar } from "./topbar";
import { createPendingAI } from "./messages";

beforeAll(() => setLadderAnimationsForTest(true));
afterAll(() => setLadderAnimationsForTest(null));

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"].map(effort => ({ effort: effort as EffortLevel, description: effort }));

function claude(id: string) {
  return { id, label: id, maxContext: 1_000_000, supportedEfforts: CLAUDE_EFFORTS, defaultEffort: "high" as EffortLevel };
}

const ANTHROPIC: ProviderInfo = {
  id: "anthropic",
  label: "Anthropic",
  defaultModel: "claude-opus-5-5",
  allowsCustomModels: false,
  supportsFastMode: false,
  models: ["claude-opus-5-1", "claude-opus-5-5", "claude-fable-5-1", "claude-fable-5-2", "claude-sonnet-5-5", "claude-haiku-5-5"].map(claude),
};

const OPENAI: ProviderInfo = {
  id: "openai",
  label: "OpenAI",
  defaultModel: "gpt-6-sol",
  allowsCustomModels: false,
  supportsFastMode: true,
  models: [{ id: "gpt-6-sol", label: "GPT-6-Sol", maxContext: 272_000, supportedEfforts: CLAUDE_EFFORTS, defaultEffort: "high" }],
};

function summary(state: RenderState, patch: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: "conv-1",
    provider: state.provider,
    model: state.model,
    effort: state.effort,
    fastMode: false,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    title: "Ladder",
    marked: false,
    pinned: false,
    streaming: false,
    unread: false,
    sortOrder: 1,
    ...patch,
  };
}

function ladderState(model: ModelId = "claude-opus-5-5", effort: EffortLevel = "high", provider: "anthropic" | "openai" = "anthropic"): RenderState {
  const state = createInitialState();
  state.providerRegistry = [ANTHROPIC, OPENAI];
  state.provider = provider;
  state.hasChosenProvider = true;
  state.model = model;
  state.effort = effort;
  state.convId = "conv-1";
  state.sidebar.conversations = [summary(state)];
  return state;
}

function recorder(): LadderDaemon & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    setModel: (convId, provider, model, effort) => { sent.push(`set_model ${convId} ${provider}/${model} ${effort}`); },
    setEffort: (convId, effort) => { sent.push(`set_effort ${convId} ${effort}`); },
  };
}

function rung(index: number): string {
  const step = MODEL_LADDER[index];
  return `${step.family}/${step.effort}`;
}

describe("model ladder steps", () => {
  test("each rung goes one up and one down", () => {
    const models: Record<string, ModelId> = { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5", fable: "claude-fable-5-2" };
    for (let index = 0; index < MODEL_LADDER.length; index++) {
      const { family, effort } = MODEL_LADDER[index];
      const up = ladderStep("anthropic", models[family], effort, 1);
      const down = ladderStep("anthropic", models[family], effort, -1);
      expect(up).toEqual(index === MODEL_LADDER.length - 1 ? { type: "end" } : { type: "rung", rung: index + 1 });
      expect(down).toEqual(index === 0 ? { type: "end" } : { type: "rung", rung: index - 1 });
    }
    expect(MODEL_LADDER.map((_, index) => rung(index))).toEqual(["sonnet/medium", "opus/high", "opus/xhigh", "fable/high", "fable/xhigh"]);
  });

  test("between rungs it goes to the nearest rung in the pressed direction", () => {
    const at = (model: ModelId, effort: EffortLevel, dir: 1 | -1) => {
      const step = ladderStep("anthropic", model, effort, dir);
      return step.type === "rung" ? rung(step.rung) : step.type;
    };
    expect(at("claude-opus-5-5", "max", 1)).toBe("fable/high");
    expect(at("claude-opus-5-5", "max", -1)).toBe("opus/xhigh");
    expect(at("claude-opus-5-5", "low", 1)).toBe("opus/high");
    expect(at("claude-opus-5-5", "low", -1)).toBe("sonnet/medium");
    expect(at("claude-sonnet-5-5", "high", 1)).toBe("opus/high");
    expect(at("claude-sonnet-5-5", "high", -1)).toBe("sonnet/medium");
    expect(at("claude-sonnet-5-5", "low", -1)).toBe("end");
    // Haiku sits below the ladder: up joins it at the bottom rung.
    expect(at("claude-haiku-5-5", "medium", 1)).toBe("sonnet/medium");
    expect(at("claude-haiku-5-5", "medium", -1)).toBe("end");
    expect(at("claude-fable-5-2", "max", 1)).toBe("end");
    expect(at("claude-fable-5-2", "max", -1)).toBe("fable/xhigh");
    // An older version of a family counts as that family's rung.
    expect(at("claude-opus-5-1", "xhigh", 1)).toBe("fable/high");
  });

  test("non-Claude conversations are not on the ladder", () => {
    expect(ladderStep("openai", "gpt-6-sol", "high", 1)).toEqual({ type: "none" });
    expect(ladderStep("anthropic", "some-custom-model", "high", 1)).toEqual({ type: "none" });
  });

  test("family names resolve to the newest catalog model", () => {
    const ids = ANTHROPIC.models.map(model => model.id);
    expect(latestFamilyModel(ids, "opus")).toBe("claude-opus-5-5");
    expect(latestFamilyModel(ids, "fable")).toBe("claude-fable-5-2");
    expect(latestFamilyModel(ids, "haiku")).toBe("claude-haiku-5-5");
    expect(latestFamilyModel(["claude-opus-5-5[1m]", "claude-opus-5-5"], "opus")).toBe("claude-opus-5-5");
  });
});

describe("pressing Shift+Up / Shift+Down", () => {
  test("sets model and effort together and tells the daemon", () => {
    const state = ladderState("claude-sonnet-5-5", "medium");
    const daemon = recorder();
    expect(pressModelLadder(state, 1, daemon, 1_000, true)).toBe("stepped");
    expect([state.model, state.effort]).toEqual(["claude-opus-5-5", "high"]);
    for (let press = 2; press <= 4; press++) expect(pressModelLadder(state, 1, daemon, press * 1_000, true)).toBe("stepped");
    expect([state.model, state.effort]).toEqual(["claude-fable-5-2", "xhigh"]);
    expect(pressModelLadder(state, 1, daemon, 5_000, true)).toBe("end");
    expect(daemon.sent).toEqual([
      "set_model conv-1 anthropic/claude-opus-5-5 high",
      // Same model, effort only.
      "set_effort conv-1 xhigh",
      "set_model conv-1 anthropic/claude-fable-5-2 high",
      "set_effort conv-1 xhigh",
    ]);
  });

  test("runs the whole way down to sonnet/medium and stops there", () => {
    const state = ladderState("claude-fable-5-2", "xhigh");
    const daemon = recorder();
    const seen: string[] = [];
    for (let press = 0; press < 6; press++) {
      const result = pressModelLadder(state, -1, daemon, 1_000 + press * 1_000, true);
      seen.push(`${result} ${state.model} ${state.effort}`);
    }
    expect(seen).toEqual([
      "stepped claude-fable-5-2 high",
      "stepped claude-opus-5-5 xhigh",
      "stepped claude-opus-5-5 high",
      "stepped claude-sonnet-5-5 medium",
      "end claude-sonnet-5-5 medium",
      "end claude-sonnet-5-5 medium",
    ]);
  });

  test("does nothing on a non-Claude conversation", () => {
    const state = ladderState("gpt-6-sol", "high", "openai");
    const daemon = recorder();
    expect(pressModelLadder(state, 1, daemon, 1_000, true)).toBe("ignored");
    expect(state.model).toBe("gpt-6-sol");
    expect(state.modelLadder?.anim ?? null).toBeNull();
    expect(daemon.sent).toEqual([]);
  });

  test("a draft changes only its own selection, nothing is sent", () => {
    const state = ladderState("claude-opus-5-5", "xhigh");
    state.convId = null;
    const daemon = recorder();
    expect(pressModelLadder(state, 1, daemon, 1_000, true)).toBe("stepped");
    expect(state.model).toBe("claude-fable-5-2");
    expect(daemon.sent).toEqual([]);
  });

  test("presses closer than the step interval are dropped, not queued", () => {
    const state = ladderState("claude-sonnet-5-5", "medium");
    const daemon = recorder();
    expect(pressModelLadder(state, 1, daemon, 1_000, true)).toBe("stepped");
    expect(pressModelLadder(state, 1, daemon, 1_000 + LADDER_MIN_STEP_MS - 1, true)).toBe("ignored");
    expect([state.model, state.effort]).toEqual(["claude-opus-5-5", "high"]);
    expect(pressModelLadder(state, 1, daemon, 1_000 + LADDER_MIN_STEP_MS, true)).toBe("stepped");
    expect([state.model, state.effort]).toEqual(["claude-opus-5-5", "xhigh"]);
  });
});

describe("mid-turn: the switch waits for the turn to end", () => {
  function streamingState(model: ModelId = "claude-opus-5-5", effort: EffortLevel = "xhigh"): RenderState {
    const state = ladderState(model, effort);
    state.pendingAI = createPendingAI(1, model);
    return state;
  }

  test("a model step is queued with the daemon; the running turn keeps its model", () => {
    const state = streamingState();
    const daemon = recorder();
    expect(pressModelLadder(state, 1, daemon, 1_000, true)).toBe("queued");
    expect([state.model, state.effort]).toEqual(["claude-opus-5-5", "xhigh"]);
    expect(daemon.sent).toEqual(["set_model conv-1 anthropic/claude-fable-5-2 high"]);
    expect(queuedModel(state)).toEqual({ provider: "anthropic", model: "claude-fable-5-2", effort: "high" });
    // No refusal: the label goes to the waiting model and the meter shows where.
    const anim = state.modelLadder!.anim!;
    expect(anim.cue).toBeNull();
    expect(anim.waiting).toMatchObject({ rung: 3, dir: 1 });
    expect(anim.rung).toBe(2);
  });

  test("the ladder steps on from the waiting model; only the last target counts", () => {
    const state = streamingState();
    const daemon = recorder();
    pressModelLadder(state, 1, daemon, 1_000, true);
    pressModelLadder(state, 1, daemon, 2_000, true);
    expect(queuedModel(state)).toEqual({ provider: "anthropic", model: "claude-fable-5-2", effort: "xhigh" });
    expect(pressModelLadder(state, 1, daemon, 3_000, true)).toBe("end");
    expect(daemon.sent).toEqual([
      "set_model conv-1 anthropic/claude-fable-5-2 high",
      "set_model conv-1 anthropic/claude-fable-5-2 xhigh",
    ]);
  });

  test("stepping back to the running model clears the queue; effort-only steps apply at once", () => {
    const state = streamingState();
    const daemon = recorder();
    pressModelLadder(state, 1, daemon, 1_000, true);
    expect(pressModelLadder(state, -1, daemon, 2_000, true)).toBe("stepped");
    expect(queuedModel(state)).toBeNull();
    expect(state.modelLadder!.anim!.waiting).toBeNull();
    expect(daemon.sent.at(-1)).toBe("set_model conv-1 anthropic/claude-opus-5-5 xhigh");

    const fable = streamingState("claude-fable-5-2", "high");
    const fableDaemon = recorder();
    expect(pressModelLadder(fable, 1, fableDaemon, 1_000, true)).toBe("stepped");
    expect(fable.effort).toBe("xhigh");
    expect(fableDaemon.sent).toEqual(["set_effort conv-1 xhigh"]);
  });

  test("a switch waiting from elsewhere (another client, /model) shows and steps from there", () => {
    const state = streamingState();
    state.sidebar.conversations = [summary(state, { streaming: true, pendingModel: { provider: "anthropic", model: "claude-fable-5-2", effort: "xhigh" } })];
    expect(queuedModel(state)?.model).toBe("claude-fable-5-2");
    const bar = stripAnsi(renderTopbar(state, 90, 1_000));
    expect(bar.trimEnd().endsWith("Anthropic/Fable-5.2 — xhigh")).toBe(true);
    const daemon = recorder();
    pressModelLadder(state, -1, daemon, 2_000, true);
    expect(daemon.sent).toEqual(["set_model conv-1 anthropic/claude-fable-5-2 high"]);
  });

  test("waiting: dimmed label, meter up with the target rung breathing, until the switch lands", () => {
    const state = streamingState();
    const daemon = recorder();
    pressModelLadder(state, 1, daemon, 1_000, true);
    const frames = Array.from({ length: 200 }, (_, i) => renderTopbar(state, 90, 1_000 + i * 16));
    const late = frames.at(-1)!;
    expect(stripAnsi(late).trimEnd()).toMatch(/━━━━━ +Anthropic\/Fable-5\.2 — high$/);
    // Not the normal colour: the label is dimmed.
    expect(late).not.toBe(renderTopbar({ ...state, modelLadder: null, pendingAI: null, sidebar: { ...state.sidebar, conversations: [summary(state)] } } as RenderState, 90, 4_200));
    // It keeps drawing (the rung breathes) at a slow rate.
    expect(modelLadderFrameDelay(state, 1_000 + 199 * 16)).toBe(WAIT_FRAME_MS);
    // A breathing rung changes colour over time (brightest half way through a breath, darkest at its end).
    expect(frames[56]).not.toBe(frames[112]);

    // The daemon confirms it is queued.
    handleEvent({ type: "conversation_updated", summary: summary(state, { streaming: true, pendingModel: { provider: "anthropic", model: "claude-fable-5-2", effort: "high" } }) }, state, null as never);
    expect(state.modelLadder!.inFlight).toBeNull();
    expect(stripAnsi(renderTopbar(state, 90, 5_000)).trimEnd().endsWith("Anthropic/Fable-5.2 — high")).toBe(true);

    // The turn ends: the daemon switched; the label brightens and the bar ends exactly normal.
    state.pendingAI = null;
    handleEvent({ type: "conversation_updated", summary: summary(state, { model: "claude-fable-5-2", effort: "high", streaming: false }) }, state, null as never);
    expect([state.model, state.effort]).toEqual(["claude-fable-5-2", "high"]);
    const settle = Array.from({ length: 120 }, (_, i) => renderTopbar(state, 90, 6_000 + i * 16));
    expect(state.modelLadder!.anim?.waiting ?? null).toBeNull();
    const normal = renderTopbar({ ...state, modelLadder: null } as RenderState, 90, 9_000);
    expect(settle.at(-1)).toBe(normal);
  });

  test("a daemon refusal shows a refusal cue and the real selection", () => {
    const state = ladderState("claude-opus-5-5", "high");
    pressModelLadder(state, 1, recorder(), Date.now(), true);
    handleEvent({ type: "error", convId: "conv-1", message: "Unknown model" }, state, null as never);
    expect([state.model, state.effort]).toEqual(["claude-opus-5-5", "high"]);
    expect(state.modelLadder!.anim!.cue?.kind).toBe("refused");
  });
});

describe("keys", () => {
  test("st's Shift+Up/Down encodings parse and bind to the ladder", () => {
    expect(parseInput("\x1b[1;2A")).toEqual([{ type: "shift-up" }]);
    expect(parseInput("\x1b[1;2B")).toEqual([{ type: "shift-down" }]);
    // Kitty keyboard protocol repeat events.
    expect(parseInput("\x1b[1;2:2A")).toEqual([{ type: "shift-up", event: "repeat" }]);
    expect(parseInput("\x1b[A")).toEqual([{ type: "up" }]);
    expect(resolveAction({ type: "shift-up" })).toBe("model_ladder_up");
    expect(resolveAction({ type: "shift-down" })).toBe("model_ladder_down");
  });

  test("work from the prompt, the history and the sidebar", () => {
    const state = ladderState();
    expect(handleFocusedKey({ type: "shift-up" }, state)).toEqual({ type: "model_ladder", direction: 1 });
    state.vim.mode = "normal";
    state.panelFocus = "chat";
    state.chatFocus = "history";
    expect(handleFocusedKey({ type: "shift-down" }, state)).toEqual({ type: "model_ladder", direction: -1 });
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    expect(handleFocusedKey({ type: "shift-up" }, state)).toEqual({ type: "model_ladder", direction: 1 });
  });
});

describe("top bar animation", () => {
  const WIDTH = 90;

  function normalBar(state: RenderState): string {
    const ladder = state.modelLadder;
    state.modelLadder = null;
    const bar = renderTopbar(state, WIDTH);
    state.modelLadder = ladder;
    return bar;
  }

  /** Render frames every `step` ms (frames on time, so nothing snaps). */
  function framesUntil(state: RenderState, from: number, to: number, step = 16): string[] {
    const frames: string[] = [];
    for (let now = from; now <= to; now += step) frames.push(renderTopbar(state, WIDTH, now));
    return frames;
  }

  test("plays, then ends on exactly the normal top bar", () => {
    const state = ladderState("claude-opus-5-5", "xhigh");
    pressModelLadder(state, 1, recorder(), 1_000, true);
    const frames = framesUntil(state, 1_000, 1_000 + METER_HOLD_MS + METER_FADE_MS + 32);
    const normal = normalBar(state);
    expect(frames.some(frame => frame !== normal)).toBe(true);
    // Mid-morph the meter is up, and only colour moves: no frame ever draws a block
    // glyph, every cell is a character of one of the two labels or the meter.
    expect(stripAnsi(frames[8])).toContain("━━━━━");
    const allowed = new Set("Anthropic/Opus-5.5 — xhigh" + "Anthropic/Fable-5.2 — high" + "━ ");
    for (const frame of frames) {
      const right = stripAnsi(frame).slice(stripAnsi(frame).indexOf("━"));
      if (right.startsWith("━")) expect([...right].every(ch => allowed.has(ch))).toBe(true);
      expect(stripAnsi(frame)).not.toMatch(/[▁▂▃▄▅▆▇█▓▒░]/);
    }
    // Every frame keeps the bar's width and leaves the title in place.
    for (const frame of frames) {
      expect(stripAnsi(frame).length).toBe(WIDTH);
      expect(stripAnsi(frame).startsWith(stripAnsi(normal).slice(0, 12))).toBe(true);
    }
    expect(frames.at(-1)).toBe(normal);
    expect(stripAnsi(normal)).toContain("Anthropic/Fable-5.2 — high");
    expect(modelLadderFrameDelay(state, 1_000 + METER_HOLD_MS + METER_FADE_MS + 32)).toBeNull();
    expect(state.modelLadder?.anim).toBeNull();
  });

  test("after the morph the label is final and only the meter remains until it fades", () => {
    const state = ladderState("claude-opus-5-5", "xhigh");
    pressModelLadder(state, 1, recorder(), 1_000, true);
    // A morph knows its own length; this one is done well inside MORPH_TOTAL_MS.
    framesUntil(state, 1_000, 1_000 + 560);
    expect(state.modelLadder!.anim!.morph!.plan!.endsAt).toBeLessThan(560);
    const settled = stripAnsi(renderTopbar(state, WIDTH, 1_000 + 600));
    expect(settled).toContain("━━━━━ ");
    expect(settled.trimEnd().endsWith("Anthropic/Fable-5.2 — high")).toBe(true);
    // Idle meter: the next frame is due when it starts fading, not every tick.
    expect(modelLadderFrameDelay(state, 1_000 + 700)).toBe(METER_HOLD_MS - 700);
  });

  test("a repeat press retargets mid-flight without restarting the meter or moving it", () => {
    const state = ladderState("claude-opus-5-5", "xhigh");
    const daemon = recorder();
    pressModelLadder(state, 1, daemon, 1_000, true);
    framesUntil(state, 1_000, 1_000 + 160);
    const anim = state.modelLadder!.anim!;
    const meterAt = stripAnsi(renderTopbar(state, WIDTH, 1_176)).indexOf("━━━━━");
    pressModelLadder(state, 1, daemon, 1_180, true);
    expect(state.modelLadder!.anim).toBe(anim);
    expect(anim.morph?.startAt).toBe(1_180);
    expect(anim.rung).toBe(4);
    // The new morph starts from what was on screen, not from the old label.
    expect(anim.morph?.from.map(cell => cell.ch).join("")).not.toBe("Anthropic/Fable-5.2 — high");
    const frames = framesUntil(state, 1_180, 1_180 + MORPH_TOTAL_MS);
    for (const frame of frames) expect(stripAnsi(frame).indexOf("━━━━━")).toBe(meterAt);
    expect(stripAnsi(frames.at(-1)!).trimEnd().endsWith("Anthropic/Fable-5.2 — xhigh")).toBe(true);
  });

  test("the leading text moves as one block: no frame shows it doubled or torn", () => {
    // Sonnet-5.5 — medium -> Opus-5.5 — high is four cells shorter, so the right-aligned "Anthropic/" moves right by four.
    const state = ladderState("claude-sonnet-5-5", "medium");
    pressModelLadder(state, 1, recorder(), 1_000, true);
    const frames = framesUntil(state, 1_000, 1_000 + 640).map(stripAnsi);
    for (const frame of frames) expect(frame.split("Anthropic/").length - 1).toBe(1);
    const at = (frame: string) => frame.indexOf("Anthropic/");
    expect(at(frames.at(-1)!) - at(frames[0])).toBe(4);
    // It never moves back, and the new name only appears once it has arrived.
    for (let i = 1; i < frames.length; i++) expect(at(frames[i])).toBeGreaterThanOrEqual(at(frames[i - 1]));
    const firstNew = frames.findIndex(frame => frame.includes("Anthropic/O"));
    expect(at(frames[firstNew])).toBe(at(frames.at(-1)!));
    expect(frames.at(-1)!.trimEnd().endsWith("Anthropic/Opus-5.5 — high")).toBe(true);
  });

  test("an effort-only step changes just the letters that differ", () => {
    const state = ladderState("claude-fable-5-2", "high");
    pressModelLadder(state, 1, recorder(), 1_000, true);
    const plan = () => state.modelLadder!.anim!.morph!.plan!;
    const frames = framesUntil(state, 1_000, 1_000 + 560).map(stripAnsi);
    // "high" -> "xhigh": one new letter, nothing sinks, everything before it slides one cell.
    expect(plan()).toMatchObject({ suffix: 4, oldMid: 0, newMid: 1 });
    for (const frame of frames) expect(frame).toMatch(/Anthropic\/Fable-5\.2 — [x ]?high *$/);
    // The light gets to the change quickly however long the text before it is.
    expect(plan().inAt).toBeLessThanOrEqual(120);
  });

  test("a frame far too late shows the result at once", () => {
    const state = ladderState("claude-opus-5-5", "xhigh");
    pressModelLadder(state, 1, recorder(), 1_000, true);
    const late = stripAnsi(renderTopbar(state, WIDTH, 1_000 + LADDER_LATE_FRAME_MS + 1));
    expect(late.trimEnd().endsWith("Anthropic/Fable-5.2 — high")).toBe(true);
    expect(state.modelLadder?.anim?.morph).toBeNull();
  });

  test("end of the ladder pulses without changing the label", () => {
    const state = ladderState("claude-fable-5-2", "xhigh");
    pressModelLadder(state, 1, recorder(), 1_000, true);
    expect(state.modelLadder?.anim?.cue).toMatchObject({ kind: "end", dir: 1 });
    expect(state.modelLadder?.anim?.rung).toBe(4);
    for (const frame of framesUntil(state, 1_000, 1_400)) {
      expect(stripAnsi(frame).trimEnd()).toMatch(/━━━━━ +Anthropic\/Fable-5\.2 — xhigh$/);
    }
  });

  test("without animations the switch is instant", () => {
    const state = ladderState("claude-opus-5-5", "xhigh");
    pressModelLadder(state, 1, recorder(), 1_000, false);
    expect(state.modelLadder?.anim).toBeNull();
    expect(renderTopbar(state, WIDTH, 1_000)).toBe(normalBar(state));
  });
});

describe("daemon summaries while a step is on its way", () => {
  test("an older summary does not put the old model back; the matching one clears the hold", () => {
    const state = ladderState("claude-opus-5-5", "xhigh");
    const daemon = recorder();
    pressModelLadder(state, 1, daemon, Date.now() - 2_000, true);
    pressModelLadder(state, 1, daemon, Date.now() - 1_000, true);
    expect([state.model, state.effort]).toEqual(["claude-fable-5-2", "xhigh"]);
    // set_model of the first step lands (old effort), then the first set_effort.
    handleEvent({ type: "conversation_updated", summary: summary(state, { model: "claude-fable-5-2", effort: "high" }) }, state, null as never);
    expect([state.model, state.effort]).toEqual(["claude-fable-5-2", "xhigh"]);
    handleEvent({ type: "conversation_updated", summary: summary(state, { model: "claude-fable-5-2", effort: "xhigh" }) }, state, null as never);
    expect(state.modelLadder?.inFlight).toBeNull();
    // Later changes from elsewhere apply as usual.
    handleEvent({ type: "conversation_updated", summary: summary(state, { model: "claude-opus-5-5", effort: "max" }) }, state, null as never);
    expect([state.model, state.effort]).toEqual(["claude-opus-5-5", "max"]);
  });

  test("a rejection shows what the daemon really has", () => {
    const state = ladderState("claude-opus-5-5", "xhigh");
    pressModelLadder(state, 1, recorder(), Date.now(), true);
    expect(state.model).toBe("claude-fable-5-2");
    handleEvent({ type: "error", convId: "conv-1", message: "Cannot switch provider/model while the conversation is streaming." }, state, null as never);
    expect([state.model, state.effort]).toEqual(["claude-opus-5-5", "xhigh"]);
    expect(state.modelLadder?.inFlight).toBeNull();
  });
});
