/**
 * The model ladder: Shift+Up / Shift+Down step the open conversation one rung
 * up or down
 *
 *   haiku/medium → sonnet/high → opus/high → fable/high → fable/xhigh
 *
 * setting model and effort together, as /model and /effort do (set_model with
 * its effort, or set_effort). Family names resolve to the newest model of that
 * family in the provider catalog. A Claude conversation between rungs
 * (opus/xhigh, an older opus) goes to the nearest rung in the pressed
 * direction, ordering by family and then effort: opus/xhigh goes up to
 * fable/high and down to opus/high. Other providers ignore the keys.
 *
 * While the conversation streams, a model switch waits for the turn to end
 * (the daemon holds it: pendingModel on the summary) and the ladder steps on
 * from the waiting model; stepping back to the running model drops it.
 * Effort-only steps apply at once. The animation is modelladder-anim.ts.
 */

import type { ConversationSummary, EffortLevel, ModelId, PendingModelSelection, ProviderId } from "./messages";
import { focusedConversation, getModelInfo, getProviderInfo, isStreaming, type RenderState } from "./state";
import { applyProviderModelSelection } from "./commands/shared";
import { normalizeEffortForModel } from "./messages";
import { terminalColorLevel } from "./theme";
import { topbarLadderPalette, topbarModelLabel } from "./topbar";
import {
  CUE_MS,
  ladderAnimationDone,
  ladderLabelCells,
  ladderNextFrameDelay,
  labelCells,
  waitingRgb,
  type LadderAnimation,
  type LadderCell,
  type LadderDirection,
} from "./modelladder-anim";

export type ClaudeFamily = "haiku" | "sonnet" | "opus" | "fable";

export interface LadderRung {
  family: ClaudeFamily;
  effort: EffortLevel;
}

export const MODEL_LADDER: readonly LadderRung[] = [
  { family: "haiku", effort: "medium" },
  { family: "sonnet", effort: "high" },
  { family: "opus", effort: "high" },
  { family: "fable", effort: "high" },
  { family: "fable", effort: "xhigh" },
];

const FAMILY_RANK: Record<ClaudeFamily, number> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 };
const EFFORT_RANK: Record<EffortLevel, number> = { none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6, ultra: 7 };

/** Presses closer together than this are dropped, so a held key climbs a rung at a time instead of piling up. */
export const LADDER_MIN_STEP_MS = 110;
/** How long the TUI keeps its own selection over daemon summaries that predate it. */
export const LADDER_PENDING_MS = 5000;

const CLAUDE_ID_RE = /^claude-(haiku|sonnet|opus|fable)-(\d+)(?:-(\d{1,2}))?(?=$|[-[])/;

export function claudeFamily(model: ModelId): ClaudeFamily | null {
  return (CLAUDE_ID_RE.exec(model)?.[1] as ClaudeFamily | undefined) ?? null;
}

/** The newest catalog model of `family` (highest version; the plain id wins a tie). */
export function latestFamilyModel(models: readonly ModelId[], family: ClaudeFamily): ModelId | null {
  let best: { id: ModelId; major: number; minor: number } | null = null;
  for (const id of models) {
    const match = CLAUDE_ID_RE.exec(id);
    if (!match || match[1] !== family) continue;
    const major = Number(match[2]);
    const minor = match[3] ? Number(match[3]) : 0;
    if (!best || major > best.major || (major === best.major && minor > best.minor)
        || (major === best.major && minor === best.minor && id.length < best.id.length)) {
      best = { id, major, minor };
    }
  }
  return best?.id ?? null;
}

function rungKey(family: ClaudeFamily, effort: EffortLevel): number {
  return FAMILY_RANK[family] * 100 + EFFORT_RANK[effort];
}

/** The rung the conversation is on (family and effort; any version of the family), or null. */
export function ladderRungOf(model: ModelId, effort: EffortLevel): number | null {
  const family = claudeFamily(model);
  if (!family) return null;
  const index = MODEL_LADDER.findIndex(rung => rung.family === family && rung.effort === effort);
  return index >= 0 ? index : null;
}

export type LadderStep =
  | { type: "rung"; rung: number }
  | { type: "end" }
  | { type: "none" };

/** Where `dir` goes from model/effort: the next rung past it, the end of the ladder, or nothing (not Claude). */
export function ladderStep(provider: string, model: ModelId, effort: EffortLevel, dir: LadderDirection): LadderStep {
  if (provider !== "anthropic") return { type: "none" };
  const family = claudeFamily(model);
  if (!family) return { type: "none" };
  const here = rungKey(family, effort);
  const keys = MODEL_LADDER.map(rung => rungKey(rung.family, rung.effort));
  if (dir > 0) {
    const next = keys.findIndex(key => key > here);
    return next >= 0 ? { type: "rung", rung: next } : { type: "end" };
  }
  for (let index = keys.length - 1; index >= 0; index--) {
    if (keys[index] < here) return { type: "rung", rung: index };
  }
  return { type: "end" };
}

/** What a step sends to the daemon. */
export interface LadderDaemon {
  setModel(convId: string, provider: ProviderId, model: ModelId, effort?: EffortLevel): void;
  setEffort(convId: string, effort: EffortLevel): void;
}

/** A step on its way to the daemon: what the conversation's summary will say once it lands. */
interface LadderStepInFlight {
  convId: string;
  model: ModelId;
  effort: EffortLevel;
  /** The step waits for the turn to end (pendingModel), rather than taking effect. */
  queued: boolean;
  expiresAt: number;
  /** The selection before this run of presses, restored if the daemon rejects it. */
  before: { model: ModelId; effort: EffortLevel; fastMode: RenderState["fastMode"] };
  /** Newest daemon summary held back meanwhile: the truth if the change fails. */
  held: ConversationSummary | null;
}

export interface ModelLadderState {
  anim: LadderAnimation | null;
  inFlight: LadderStepInFlight | null;
  lastPressAt: number;
  /** What the bar last showed for the open conversation, so changes from elsewhere animate too. */
  shown: { convId: string | null; label: string; queued: PendingModelSelection | null } | null;
}

export type LadderPress = "stepped" | "queued" | "end" | "ignored";

let animationsOverride: boolean | null = null;

/** Animations need wall-clock frames and enough colour to show a wash. */
export function ladderAnimationsAvailable(): boolean {
  return animationsOverride ?? terminalColorLevel !== "16";
}

export function setLadderAnimationsForTest(enabled: boolean | null): void {
  animationsOverride = enabled;
}

function sameSelection(a: PendingModelSelection | null, b: PendingModelSelection | null): boolean {
  return a === b || (!!a && !!b && a.provider === b.provider && a.model === b.model && a.effort === b.effort);
}

/** The model switch waiting for the open conversation's turn to end, as the bar should show it. */
export function queuedModel(state: RenderState): PendingModelSelection | null {
  const inFlight = state.modelLadder?.inFlight;
  if (inFlight && inFlight.convId === state.convId) {
    return inFlight.queued ? { provider: "anthropic", model: inFlight.model, effort: inFlight.effort } : null;
  }
  if (!state.convId) return null;
  return focusedConversation(state)?.pendingModel ?? null;
}

/** The label the bar shows on the right: the waiting model while there is one. */
export function ladderLabel(state: RenderState, queued = queuedModel(state)): string {
  return queued ? topbarModelLabel(state, queued.model, queued.effort, queued.provider) : topbarModelLabel(state);
}

function ladderSlot(state: RenderState, models: readonly ModelId[], extra: readonly string[]): number {
  let width = 0;
  for (const rung of MODEL_LADDER) {
    const model = latestFamilyModel(models, rung.family);
    if (model) width = Math.max(width, Array.from(topbarModelLabel(state, model, rung.effort, "anthropic")).length);
  }
  for (const label of extra) width = Math.max(width, Array.from(label).length);
  return width;
}

function anthropicModels(state: RenderState): ModelId[] {
  return getProviderInfo(state, "anthropic")?.models.map(model => model.id) ?? [];
}

function startAnimation(state: RenderState, ladder: ModelLadderState, labels: readonly string[], now: number): LadderAnimation {
  const previous = ladder.anim && ladder.anim.convId === state.convId && !ladderAnimationDone(ladder.anim, now) ? ladder.anim : null;
  const slot = Math.max(previous?.slot ?? 0, ladderSlot(state, anthropicModels(state), labels));
  const anim: LadderAnimation = previous ?? {
    convId: state.convId,
    slot,
    rung: null,
    rungAt: now,
    lastPressAt: now,
    lastFrameAt: now,
    morph: null,
    cue: null,
    waiting: null,
  };
  anim.slot = slot;
  anim.lastPressAt = now;
  anim.lastFrameAt = now;
  return anim;
}

function ladderState(state: RenderState): ModelLadderState {
  state.modelLadder ??= { anim: null, inFlight: null, lastPressAt: -Infinity, shown: null };
  return state.modelLadder;
}

function selectionRung(selection: PendingModelSelection | null): number | null {
  return selection && selection.provider === "anthropic" ? ladderRungOf(selection.model, selection.effort) : null;
}

/** Where the waiting switch sits relative to the running model: up or down the ladder. */
function waitingDirection(state: RenderState, queued: PendingModelSelection, fallback: LadderDirection): LadderDirection {
  const from = state.provider === "anthropic" ? claudeFamily(state.model) : null;
  const to = queued.provider === "anthropic" ? claudeFamily(queued.model) : null;
  if (!from || !to) return fallback;
  const delta = rungKey(to, queued.effort) - rungKey(from, state.effort);
  return delta > 0 ? 1 : delta < 0 ? -1 : fallback;
}

/** The label cells on screen now: mid-animation, waiting (dimmed) or at rest. */
function shownCells(state: RenderState, ladder: ModelLadderState, label: string, waiting: boolean, now: number): LadderCell[] {
  const palette = topbarLadderPalette();
  if (ladder.anim && ladder.anim.convId === state.convId && !ladderAnimationDone(ladder.anim, now)) {
    return ladderLabelCells(ladder.anim, label, now, palette);
  }
  return labelCells(label, waiting ? waitingRgb(palette) : null);
}

/**
 * Shift+Up (dir 1) / Shift+Down (dir -1). Applies the step to the open
 * conversation (or the draft), tells the daemon, and starts the animation.
 */
export function pressModelLadder(
  state: RenderState,
  dir: LadderDirection,
  daemon: LadderDaemon,
  now = Date.now(),
  animate = ladderAnimationsAvailable(),
): LadderPress {
  if (state.sshConnecting) return "ignored";
  const queued = queuedModel(state);
  const from = queued ?? { provider: state.provider, model: state.model, effort: state.effort };
  const step = ladderStep(from.provider, from.model, from.effort, dir);
  if (step.type === "none") return "ignored";
  const ladder = ladderState(state);
  if (now - ladder.lastPressAt < LADDER_MIN_STEP_MS) return "ignored";
  ladder.lastPressAt = now;

  const fromLabel = ladderLabel(state, queued);
  const fromCells = shownCells(state, ladder, fromLabel, !!queued, now);
  const runningRung = state.provider === "anthropic" ? ladderRungOf(state.model, state.effort) : null;

  if (step.type === "end") {
    if (animate) {
      const anim = startAnimation(state, ladder, [fromLabel], now);
      if (!queued) {
        if (anim.rung !== runningRung) anim.rungAt = now;
        anim.rung = runningRung ?? (dir > 0 ? MODEL_LADDER.length - 1 : 0);
      }
      // Holding against the end keeps the meter up without restarting the pulse.
      if (anim.cue?.kind !== "end" || now - anim.cue.startAt >= CUE_MS) anim.cue = { kind: "end", startAt: now, dir };
      ladder.anim = anim;
    }
    return "end";
  }

  const rung = MODEL_LADDER[step.rung];
  const model = latestFamilyModel(anthropicModels(state), rung.family);
  if (!model) return "ignored";
  const effort = normalizeEffortForModel(getModelInfo(state, "anthropic", model), rung.effort);
  const switchesModel = state.provider !== "anthropic" || model !== state.model;
  const convId = state.convId;
  const waits = !!convId && switchesModel && isStreaming(state);
  const before = { model: state.model, effort: state.effort, fastMode: state.fastMode };

  if (convId) {
    if (waits) {
      daemon.setModel(convId, "anthropic", model, effort);
    } else if (switchesModel || queued) {
      // Idle: takes effect. Streaming, back to the running model: drops the waiting one.
      if (switchesModel) applyProviderModelSelection(state, "anthropic", model);
      daemon.setModel(convId, "anthropic", model, effort);
    } else if (effort !== state.effort) {
      daemon.setEffort(convId, effort);
    }
    if (!waits) state.effort = effort;
    const carried = ladder.inFlight?.convId === convId ? ladder.inFlight : null;
    ladder.inFlight = {
      convId,
      model,
      effort,
      queued: waits,
      expiresAt: now + LADDER_PENDING_MS,
      before: carried?.before ?? before,
      held: carried?.held ?? null,
    };
  } else {
    if (switchesModel) applyProviderModelSelection(state, "anthropic", model);
    state.effort = effort;
  }

  const nextQueued: PendingModelSelection | null = waits ? { provider: "anthropic", model, effort } : null;
  const label = ladderLabel(state, nextQueued);
  ladder.shown = { convId, label, queued: nextQueued };
  if (animate) {
    const anim = startAnimation(state, ladder, [fromLabel, label], now);
    anim.morph = { from: fromCells, startAt: now, dir };
    anim.cue = null;
    const lit = waits ? runningRung : step.rung;
    if (anim.rung !== lit) anim.rungAt = now;
    anim.rung = lit;
    anim.waiting = nextQueued
      ? { rung: step.rung, dir: waitingDirection(state, nextQueued, dir), since: anim.waiting?.since ?? now }
      : null;
    ladder.anim = anim;
  } else {
    ladder.anim = null;
  }
  return waits ? "queued" : "stepped";
}

/**
 * Before each top-bar frame: notice when the waiting switch changed without a
 * press here (another client, /model, the turn ending) and animate that too.
 */
export function syncModelLadder(state: RenderState, now = Date.now(), animate = ladderAnimationsAvailable()): void {
  const ladder = state.modelLadder;
  const queued = queuedModel(state);
  if (!ladder && !queued) return;
  const ls = ladderState(state);
  const label = ladderLabel(state, queued);
  const shown = ls.shown;
  ls.shown = { convId: state.convId, label, queued };
  if (!animate) return;
  const runningRung = state.provider === "anthropic" ? ladderRungOf(state.model, state.effort) : null;
  if (!shown || shown.convId !== state.convId) {
    // Another conversation is open: show its waiting switch as it stands.
    if (ls.anim && ls.anim.convId !== state.convId) ls.anim = null;
    if (queued && !ls.anim?.waiting) {
      const anim = startAnimation(state, ls, [label], now);
      anim.rung = runningRung;
      anim.waiting = { rung: selectionRung(queued), dir: waitingDirection(state, queued, 1), since: now };
      ls.anim = anim;
    }
    return;
  }
  // Only the waiting switch animates here; other label changes (/effort, a
  // proxy's state) just show.
  if (sameSelection(shown.queued, queued)) return;
  const fromCells = shownCells(state, ls, shown.label, !!shown.queued, now);
  const applied = !queued && !!shown.queued && shown.queued.model === state.model;
  const dir: LadderDirection = queued
    ? waitingDirection(state, queued, 1)
    : shown.queued && ls.anim?.waiting ? (applied ? ls.anim.waiting.dir : (-ls.anim.waiting.dir as LadderDirection)) : 1;
  const anim = startAnimation(state, ls, [shown.label, label], now);
  anim.morph = { from: fromCells, startAt: now, dir };
  anim.cue = null;
  if (anim.rung !== runningRung) anim.rungAt = now;
  anim.rung = runningRung;
  anim.waiting = queued ? { rung: selectionRung(queued), dir, since: anim.waiting?.since ?? now } : null;
  ls.anim = anim;
}

/**
 * A daemon summary for the open conversation, before it is applied: true when
 * it predates the ladder's latest step and must not put the old selection back
 * on screen while the step is on its way (a held key sends several).
 */
export function ladderHoldsSummary(state: RenderState, summary: ConversationSummary, now = Date.now()): boolean {
  const inFlight = state.modelLadder?.inFlight;
  if (!inFlight || inFlight.convId !== summary.id) return false;
  const waiting = summary.pendingModel;
  const landed = summary.provider === "anthropic" && summary.model === inFlight.model && summary.effort === inFlight.effort && !waiting;
  const queuedThere = !!waiting && waiting.provider === "anthropic" && waiting.model === inFlight.model && waiting.effort === inFlight.effort;
  // A queued step can also land outright: the turn ended before it arrived.
  if (now > inFlight.expiresAt || landed || (inFlight.queued && queuedThere)) {
    state.modelLadder!.inFlight = null;
    return false;
  }
  inFlight.held = summary;
  return true;
}

/** The daemon refused something for `convId` mid-step: show what it really has, with a refusal cue. */
export function releaseLadderOnError(state: RenderState, convId: string | undefined, now = Date.now()): void {
  const ladder = state.modelLadder;
  const inFlight = ladder?.inFlight;
  if (!ladder || !inFlight || !convId || inFlight.convId !== convId) return;
  ladder.inFlight = null;
  if (state.convId !== convId) return;
  const truth = inFlight.held ?? { provider: "anthropic" as const, ...inFlight.before };
  if (truth.provider === state.provider) {
    state.model = truth.model;
    state.effort = truth.effort;
    state.fastMode = truth.fastMode;
  }
  if (ladder.anim && ladder.anim.convId === convId) {
    ladder.anim.cue = { kind: "refused", startAt: now, dir: 1 };
    ladder.anim.lastPressAt = now;
  }
}

/** Ms until the top bar's next ladder frame, or null when nothing is playing (clears a finished one). */
export function modelLadderFrameDelay(state: RenderState, now = Date.now()): number | null {
  const anim = state.modelLadder?.anim;
  if (!anim) return null;
  if (anim.convId !== state.convId) {
    state.modelLadder!.anim = null;
    return null;
  }
  const delay = ladderNextFrameDelay(anim, now);
  if (delay === null) state.modelLadder!.anim = null;
  return delay;
}
