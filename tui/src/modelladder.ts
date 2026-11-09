/**
 * The model ladder: Shift+Up / Shift+Down step the open conversation one rung
 * up or down
 *
 *   haiku/medium → sonnet/high → opus/high → fable/high → fable/xhigh
 *
 * setting model and effort together, as /model and /effort do (set_model,
 * set_effort). Family names resolve to the newest model of that family in the
 * provider catalog. A Claude conversation between rungs (opus/xhigh, an older
 * opus) goes to the nearest rung in the pressed direction, ordering by family
 * and then effort: opus/xhigh goes up to fable/high and down to opus/high.
 * Other providers ignore the keys. A model switch while the conversation
 * streams is refused (the daemon refuses it too) and shown as a refusal; an
 * effort-only step goes through, as /effort does. The animation is
 * modelladder-anim.ts.
 */

import type { ConversationSummary, EffortLevel, ModelId } from "./messages";
import { getModelInfo, getProviderInfo, isStreaming, type RenderState } from "./state";
import { applyProviderModelSelection } from "./commands/shared";
import { normalizeEffortForModel } from "./messages";
import { terminalColorLevel } from "./theme";
import { topbarModelLabel } from "./topbar";
import {
  CUE_MS,
  ladderAnimationDone,
  ladderLabelCells,
  ladderNextFrameDelay,
  labelCells,
  type LadderAnimation,
  type LadderDirection,
  type LadderStyle,
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
  setModel(convId: string, provider: "anthropic", model: ModelId): void;
  setEffort(convId: string, effort: EffortLevel): void;
}

interface PendingLadderSelection {
  convId: string;
  model: ModelId;
  effort: EffortLevel;
  expiresAt: number;
  /** The selection before this run of presses, restored if the daemon rejects it. */
  before: { model: ModelId; effort: EffortLevel; fastMode: RenderState["fastMode"] };
  /** Newest daemon summary held back meanwhile: the truth if the change fails. */
  held: ConversationSummary | null;
}

export interface ModelLadderState {
  anim: LadderAnimation | null;
  pending: PendingLadderSelection | null;
  lastPressAt: number;
}

export type LadderPress = "stepped" | "end" | "blocked" | "ignored";

function ladderStyle(): LadderStyle {
  return process.env.EXOCORTEX_LADDER_STYLE === "scan" ? "scan" : "fill";
}

/** Animations need wall-clock frames and enough colour to show a wash. */
function animationsAvailable(): boolean {
  return terminalColorLevel !== "16";
}

function ladderSlot(state: RenderState, models: readonly ModelId[], extra: readonly string[]): number {
  let width = 0;
  for (const rung of MODEL_LADDER) {
    const model = latestFamilyModel(models, rung.family);
    if (model) width = Math.max(width, Array.from(topbarModelLabel(state, model, rung.effort)).length);
  }
  for (const label of extra) width = Math.max(width, Array.from(label).length);
  return width;
}

function startAnimation(
  state: RenderState,
  ladder: ModelLadderState,
  models: readonly ModelId[],
  fromLabel: string,
  now: number,
): LadderAnimation {
  const previous = ladder.anim && ladder.anim.convId === state.convId && !ladderAnimationDone(ladder.anim, now) ? ladder.anim : null;
  const slot = Math.max(previous?.slot ?? 0, ladderSlot(state, models, [fromLabel, topbarModelLabel(state)]));
  const anim: LadderAnimation = previous ?? {
    convId: state.convId,
    style: ladderStyle(),
    slot,
    rung: null,
    rungAt: now,
    lastPressAt: now,
    lastFrameAt: now,
    morph: null,
    cue: null,
  };
  anim.slot = slot;
  anim.lastPressAt = now;
  anim.lastFrameAt = now;
  return anim;
}

function ladderState(state: RenderState): ModelLadderState {
  state.modelLadder ??= { anim: null, pending: null, lastPressAt: -Infinity };
  return state.modelLadder;
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
  animate = animationsAvailable(),
): LadderPress {
  if (state.sshConnecting) return "ignored";
  const step = ladderStep(state.provider, state.model, state.effort, dir);
  if (step.type === "none") return "ignored";
  const ladder = ladderState(state);
  if (now - ladder.lastPressAt < LADDER_MIN_STEP_MS) return "ignored";
  ladder.lastPressAt = now;

  const models = getProviderInfo(state, "anthropic")?.models.map(model => model.id) ?? [];
  const fromLabel = topbarModelLabel(state);
  const shownCells = ladder.anim && ladder.anim.convId === state.convId
    ? ladderLabelCells(ladder.anim, fromLabel, now)
    : labelCells(fromLabel);
  const currentRung = ladderRungOf(state.model, state.effort);

  if (step.type === "end") {
    if (animate) {
      const anim = startAnimation(state, ladder, models, fromLabel, now);
      if (anim.rung !== currentRung) anim.rungAt = now;
      anim.rung = currentRung ?? (dir > 0 ? MODEL_LADDER.length - 1 : 0);
      // Holding against the end keeps the meter up without restarting the pulse.
      if (anim.cue?.kind !== "end" || now - anim.cue.startAt >= CUE_MS) anim.cue = { kind: "end", startAt: now, dir, rung: null };
      ladder.anim = anim;
    }
    return "end";
  }

  const rung = MODEL_LADDER[step.rung];
  const model = latestFamilyModel(models, rung.family);
  if (!model) return "ignored";
  const effort = normalizeEffortForModel(getModelInfo(state, "anthropic", model), rung.effort);
  const modelChanges = model !== state.model;

  if (state.convId && modelChanges && isStreaming(state)) {
    if (animate) {
      const anim = startAnimation(state, ladder, models, fromLabel, now);
      if (anim.rung !== currentRung) anim.rungAt = now;
      anim.rung = currentRung;
      anim.cue = { kind: "blocked", startAt: now, dir, rung: step.rung };
      ladder.anim = anim;
    }
    return "blocked";
  }

  const before = { model: state.model, effort: state.effort, fastMode: state.fastMode };
  if (modelChanges) applyProviderModelSelection(state, "anthropic", model);
  state.effort = effort;

  if (state.convId) {
    if (modelChanges) daemon.setModel(state.convId, "anthropic", model);
    // set_model keeps the old effort when the new model has it; say the rung's.
    if (modelChanges || effort !== before.effort) daemon.setEffort(state.convId, effort);
    const carried = ladder.pending?.convId === state.convId ? ladder.pending : null;
    ladder.pending = {
      convId: state.convId,
      model,
      effort,
      expiresAt: now + LADDER_PENDING_MS,
      before: carried?.before ?? before,
      held: carried?.held ?? null,
    };
  }

  if (animate) {
    const anim = startAnimation(state, ladder, models, fromLabel, now);
    anim.morph = { from: shownCells, startAt: now, dir };
    anim.cue = null;
    anim.rung = step.rung;
    anim.rungAt = now;
    ladder.anim = anim;
  } else {
    ladder.anim = null;
  }
  return "stepped";
}

/**
 * A daemon summary for the open conversation, before it is applied: true when
 * it predates the ladder's latest step and must not put the old model back on
 * screen while the step is on its way (a held key sends several).
 */
export function ladderHoldsSummary(state: RenderState, summary: ConversationSummary, now = Date.now()): boolean {
  const pending = state.modelLadder?.pending;
  if (!pending || pending.convId !== summary.id) return false;
  if (now > pending.expiresAt
      || (summary.provider === "anthropic" && summary.model === pending.model && summary.effort === pending.effort)) {
    state.modelLadder!.pending = null;
    return false;
  }
  pending.held = summary;
  return true;
}

/** The daemon rejected something for `convId` mid-step: show what it really has. */
export function releaseLadderOnError(state: RenderState, convId: string | undefined): void {
  const pending = state.modelLadder?.pending;
  if (!pending || !convId || pending.convId !== convId) return;
  state.modelLadder!.pending = null;
  if (state.convId !== convId) return;
  const truth = pending.held ?? { provider: "anthropic" as const, ...pending.before };
  if (truth.provider !== state.provider) return;
  state.model = truth.model;
  state.effort = truth.effort;
  state.fastMode = truth.fastMode;
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
