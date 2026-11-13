/**
 * The model ladder's top-bar animation (Shift+Up / Shift+Down).
 *
 * Pure frame composition: given the animation record, the label to show and
 * the time, build the right-hand segment of the top bar.
 *
 * Only colour moves; every cell always holds a character of the old label, the
 * new one, or the meter, so the animation looks the same in any terminal and
 * font. The label is split into the text both labels start with, the part
 * that changes, and the text both end with. The changing part sinks into the
 * bar, the leading text slides over as one block to its new place (the label
 * is right-aligned, so a longer or shorter name moves it), and the new part
 * comes in letter by letter. Going up, a warm light runs left to right along
 * the label: new letters arrive lit and cool to the normal colour, and
 * unchanged text only catches the light. Going down, a shadow runs right to
 * left and the new letters rise out of the bar, with no light. A five-segment
 * meter beside the
 * label shows the rung as a length (one glyph repeated, lit by colour); the
 * segment gained lights up, the one lost fades, and the meter fades out a
 * second after the last press. When everything has played out the segment is
 * null and the top bar renders exactly as it does without the ladder.
 *
 * A model switch asked for mid-turn waits for the turn to end. Meanwhile the
 * label rests dimmed on the model it will switch to and the meter stays up:
 * the running rungs dimmed, the ones the switch adds or removes breathing,
 * until the switch lands and the label brightens back to normal.
 *
 * Frames are a function of wall-clock time, so late timers drop frames rather
 * than stretch the animation; a frame that comes far too late finishes the
 * label at once.
 */

import { rgbToAnsi, type TerminalColorLevel } from "./terminalcolors";

export type Rgb = readonly [number, number, number];
export type LadderDirection = 1 | -1;

/** One label cell: its character and colour (null = the bar's normal colour). */
export interface LadderCell {
  ch: string;
  rgb: Rgb | null;
}

export interface LadderAnimation {
  /** Conversation the animation belongs to (null = draft). */
  convId: string | null;
  /** Cells wide reserved for the label, so its width changes never move the meter. */
  slot: number;
  /** Rung lit in the meter (null: between rungs). While waiting: the running rung. */
  rung: number | null;
  /** When the lit rung last changed (it flares, then settles). */
  rungAt: number;
  lastPressAt: number;
  /** Last time a frame was composed; a long gap means the timers are not keeping up. */
  lastFrameAt: number;
  morph: {
    from: LadderCell[];
    startAt: number;
    dir: LadderDirection;
    /** The choreography for this change, worked out on its first frame. */
    plan?: MorphPlan;
  } | null;
  cue: {
    kind: "end" | "refused";
    startAt: number;
    dir: LadderDirection;
  } | null;
  /** A switch waiting for the turn to end: the rung it goes to (null: off the ladder). */
  waiting: {
    rung: number | null;
    dir: LadderDirection;
    since: number;
  } | null;
  /** When the meter first showed (it fades in); defaults to the first frame. */
  since?: number;
  /** The meter's last rung change, kept by the renderer: which segments light up or fade. */
  meter?: { rung: number | null; from: number | null; at: number };
}

/** One glyph for every meter segment: only its colour says lit or unlit, so nothing has to line up. */
export const LADDER_METER_GLYPH = "━";
export const LADDER_RUNGS = 5;

/** The light (or shadow) moves one cell in this long... */
export const FRONT_CELL_MS = 10;
/** ...but reaches the part that changes within this long, however much text comes first. */
export const FRONT_LEAD_MS = 120;
/** The changing part sinks into the bar in this long. */
export const CELL_OUT_MS = 80;
/** The leading text slides one cell in this long. */
export const SLIDE_CELL_MS = 20;
/** A new letter settles to the label colour in this long. */
export const CELL_IN_MS = 240;
/** Unchanged text brightens (or dims) this long before the front reaches it, and recovers this long after. */
export const GLOW_RISE_MS = 40;
export const GLOW_FALL_MS = 180;
/** No morph takes longer than this (a morph knows its own length once it has a plan). */
export const MORPH_TOTAL_MS = 700;
export const CUE_MS = 380;
export const METER_IN_MS = 120;
export const METER_HOLD_MS = 1000;
export const METER_FADE_MS = 280;
export const RUNG_FLARE_MS = 320;
export const LADDER_FRAME_MS = 16;
/** The waiting rungs breathe this slowly, drawn at this frame interval. */
export const WAIT_BREATH_MS = 1800;
export const WAIT_FRAME_MS = 90;
/** A frame this late means timers cannot drive the animation: show the result. */
export const LADDER_LATE_FRAME_MS = 150;

/** The light a step up carries: new text arrives in it and cools to the label colour. */
const LIGHT: Rgb = [255, 209, 102];
const REFUSED: Rgb = [255, 92, 92];

export interface LadderPalette {
  /** Top bar background. */
  bg: Rgb;
  /** Normal label colour (what cells settle toward before going back to the default). */
  fg: Rgb;
  /** Escape for the bar's own text colour, where it is not the terminal's default foreground. */
  rest?: string;
  level: TerminalColorLevel;
}

export interface LadderSegment {
  /** Styled text; leaves the bar's background in place and ends on the bar's text colour. */
  text: string;
  width: number;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}

function easeOut(t: number): number {
  const k = Math.max(0, Math.min(1, t));
  return 1 - (1 - k) * (1 - k);
}

/** The waiting label's colour: halfway into the bar. */
export function waitingRgb(palette: Pick<LadderPalette, "bg" | "fg">): Rgb {
  return mix(palette.fg, palette.bg, 0.5);
}

export function labelCells(label: string, rgb: Rgb | null = null): LadderCell[] {
  return Array.from(label, ch => ({ ch, rgb: ch === " " ? null : rgb }));
}

/** Right-align cells in a slot of `width` (blanks on the left; cut from the left if too wide). */
function alignRight(cells: LadderCell[], width: number): LadderCell[] {
  if (cells.length >= width) return cells.slice(cells.length - width);
  const pad: LadderCell[] = Array.from({ length: width - cells.length }, () => ({ ch: " ", rgb: null }));
  return [...pad, ...cells];
}

function morphDone(anim: LadderAnimation, now: number): boolean {
  return !anim.morph || now - anim.morph.startAt >= (anim.morph.plan?.endsAt ?? MORPH_TOTAL_MS);
}

function cueDone(anim: LadderAnimation, now: number): boolean {
  return !anim.cue || now - anim.cue.startAt >= CUE_MS;
}

function meterEndsAt(anim: LadderAnimation): number {
  return anim.lastPressAt + METER_HOLD_MS + METER_FADE_MS;
}

/** Nothing left to draw: the top bar is back to normal. */
export function ladderAnimationDone(anim: LadderAnimation, now: number): boolean {
  return !anim.waiting && morphDone(anim, now) && cueDone(anim, now) && now >= meterEndsAt(anim);
}

/** Milliseconds until the next frame is due, or null once the animation has played out. */
export function ladderNextFrameDelay(anim: LadderAnimation, now: number): number | null {
  if (ladderAnimationDone(anim, now)) return null;
  const moving = !morphDone(anim, now) || !cueDone(anim, now) || now - anim.rungAt < RUNG_FLARE_MS;
  if (anim.waiting) return moving ? LADDER_FRAME_MS : WAIT_FRAME_MS;
  const meterFadeAt = anim.lastPressAt + METER_HOLD_MS;
  if (moving || now >= meterFadeAt) return Math.max(1, Math.min(LADDER_FRAME_MS, meterEndsAt(anim) - now));
  // The meter just sits there until it starts fading.
  return Math.max(1, meterFadeAt - now);
}

/** The label cells as they look at `now` (used to start a new morph from mid-flight). */
export function ladderLabelCells(anim: LadderAnimation, label: string, now: number, palette: LadderPalette): LadderCell[] {
  return morphCells(anim, label, now, palette);
}

function easeIn(t: number): number {
  const k = Math.max(0, Math.min(1, t));
  return k * k;
}

/** How one label turns into the next: what stays, what changes, and when (ms from the morph's start). */
export interface MorphPlan {
  /** Cells both labels start with, and end with. */
  prefix: number;
  suffix: number;
  /** Cells of the part that changes, before and after. */
  oldMid: number;
  newMid: number;
  /** The old part starts sinking, the prefix starts sliding, the first new letter arrives. */
  outAt: number;
  slideAt: number;
  inAt: number;
  /** The front's pace, ms per cell. */
  pace: number;
  endsAt: number;
}

function trimLeadingBlanks(cells: LadderCell[]): LadderCell[] {
  let start = 0;
  while (start < cells.length && cells[start].ch === " ") start++;
  return cells.slice(start);
}

function planMorph(from: LadderCell[], to: LadderCell[]): MorphPlan {
  let prefix = 0;
  while (prefix < from.length && prefix < to.length && from[prefix].ch === to[prefix].ch) prefix++;
  let suffix = 0;
  while (
    suffix < from.length - prefix && suffix < to.length - prefix
    && from[from.length - 1 - suffix].ch === to[to.length - 1 - suffix].ch
  ) suffix++;
  return { prefix, suffix, oldMid: from.length - prefix - suffix, newMid: to.length - prefix - suffix, outAt: 0, slideAt: 0, inAt: 0, pace: 0, endsAt: 0 };
}

/** Fill in the plan's times for a sweep in `dir`. */
function timeMorph(plan: MorphPlan, dir: LadderDirection, length: number): MorphPlan {
  // Cells the front crosses before it reaches the part that changes.
  const lead = dir > 0 ? plan.prefix : plan.suffix;
  const pace = lead > 0 ? Math.min(FRONT_CELL_MS, FRONT_LEAD_MS / lead) : FRONT_CELL_MS;
  const slide = Math.abs(plan.oldMid - plan.newMid) * SLIDE_CELL_MS;
  const inAt = Math.max(lead * pace, (plan.oldMid > 0 ? CELL_OUT_MS : 0) + slide);
  const slideAt = inAt - slide;
  return { ...plan, pace, inAt, slideAt, outAt: slideAt - CELL_OUT_MS, endsAt: inAt + (length - 1 - lead) * pace + CELL_IN_MS };
}

function morphCells(anim: LadderAnimation, label: string, now: number, palette: LadderPalette): LadderCell[] {
  const rest = anim.waiting ? waitingRgb(palette) : null;
  const to = labelCells(label, rest);
  const target = alignRight(to, anim.slot);
  const morph = anim.morph;
  if (!morph) return target;
  const from = trimLeadingBlanks(morph.from);
  const plan = morph.plan ??= timeMorph(planMorph(from, to), morph.dir, to.length);
  const elapsed = now - morph.startAt;
  if (elapsed >= plan.endsAt) return target;

  const width = anim.slot;
  const up = morph.dir > 0;
  const restRgb = rest ?? palette.fg;
  const lead = up ? plan.prefix : plan.suffix;
  const newStart = width - to.length;
  /** When the front reaches a column of the new label. */
  const frontAt = (column: number): number => {
    const order = up ? column - newStart : width - 1 - column;
    return plan.inAt + (order - lead) * plan.pace;
  };
  /** Unchanged text catches the light, or dips into the shadow, as the front passes. */
  const passed = (cell: LadderCell, column: number): LadderCell => {
    const tau = elapsed - frontAt(column);
    const wasRgb = cell.rgb ?? palette.fg;
    if (tau <= -GLOW_RISE_MS) return cell;
    if (tau >= GLOW_FALL_MS) return { ch: cell.ch, rgb: rest };
    const glow = tau < 0 ? easeIn(1 + tau / GLOW_RISE_MS) : 1 - easeOut(tau / GLOW_FALL_MS);
    const base = tau < 0 ? wasRgb : mix(wasRgb, restRgb, tau / GLOW_FALL_MS);
    return { ch: cell.ch, rgb: up ? mix(base, LIGHT, 0.65 * glow) : mix(base, palette.bg, 0.3 * glow) };
  };

  const row: LadderCell[] = Array.from({ length: width }, () => ({ ch: " ", rgb: null }));
  const put = (column: number, cell: LadderCell) => { if (column >= 0 && column < width) row[column] = cell; };
  const midEnd = width - plan.suffix;

  // The part that changes sinks into the bar, all of it together.
  if (elapsed < plan.slideAt) {
    const sink = easeIn((elapsed - plan.outAt) / CELL_OUT_MS);
    for (let i = 0; i < plan.oldMid; i++) {
      const cell = from[plan.prefix + i];
      put(midEnd - plan.oldMid + i, cell.ch === " " ? cell : { ch: cell.ch, rgb: mix(cell.rgb ?? palette.fg, palette.bg, sink) });
    }
  }
  // The leading text slides to its new place as one block, a cell at a time.
  const shift = plan.oldMid - plan.newMid;
  const steps = elapsed < plan.slideAt ? 0 : Math.min(Math.abs(shift), Math.floor((elapsed - plan.slideAt) / SLIDE_CELL_MS) + 1);
  const prefixStart = midEnd - plan.oldMid - plan.prefix + Math.sign(shift) * steps;
  for (let i = 0; i < plan.prefix; i++) put(prefixStart + i, passed(from[i], newStart + i));
  // The new part comes in letter by letter as the front crosses it.
  for (let i = 0; i < plan.newMid; i++) {
    const column = midEnd - plan.newMid + i;
    const tau = elapsed - frontAt(column);
    if (tau < 0) continue;
    const cell = to[plan.prefix + i];
    put(column, cell.ch === " " || tau >= CELL_IN_MS ? cell : { ch: cell.ch, rgb: mix(up ? LIGHT : palette.bg, restRgb, easeOut(tau / CELL_IN_MS)) });
  }
  for (let i = 0; i < plan.suffix; i++) put(midEnd + i, passed(from[from.length - plan.suffix + i], midEnd + i));
  return row;
}

function fg(rgb: Rgb, level: TerminalColorLevel): string {
  return rgbToAnsi(38, rgb[0], rgb[1], rgb[2], level);
}

const DEFAULT_FG = "\x1b[39m";

function styledCells(cells: LadderCell[], level: TerminalColorLevel, rest: string = DEFAULT_FG): string {
  let out = "";
  let current: string = rest;
  for (const cell of cells) {
    const color = cell.rgb ? fg(cell.rgb, level) : rest;
    if (color !== current) {
      out += color;
      current = color;
    }
    out += cell.ch;
  }
  if (current !== rest) out += rest;
  return out;
}

/** The meter's last rung change: which segments are lit now and which were before it. */
function meterChange(anim: LadderAnimation): { rung: number | null; from: number | null; at: number } {
  if (!anim.meter) {
    // First frame: the rung before this press is one step back the way it came.
    const dir = anim.morph?.dir ?? 0;
    anim.meter = { rung: anim.rung, from: anim.rung === null ? null : anim.rung - dir, at: anim.rungAt };
  } else if (anim.meter.rung !== anim.rung) {
    anim.meter = { rung: anim.rung, from: anim.meter.rung, at: anim.rungAt };
  }
  return anim.meter;
}

function meterCells(anim: LadderAnimation, now: number, palette: LadderPalette): LadderCell[] {
  const fadeStart = anim.lastPressAt + METER_HOLD_MS;
  const fade = anim.waiting || now <= fadeStart ? 0 : (now - fadeStart) / METER_FADE_MS;
  const appear = easeOut((now - (anim.since ?? now)) / METER_IN_MS);
  const unlit = mix(palette.bg, [0, 0, 0], 0.34);
  const dimmed = mix(palette.fg, unlit, 0.5);
  const { rung, from, at } = meterChange(anim);
  const change = easeOut((now - at) / RUNG_FLARE_MS);
  const cue = anim.cue?.kind === "end" && now - anim.cue.startAt < CUE_MS ? anim.cue : null;
  const bump = cue ? Math.sin(((now - cue.startAt) / CUE_MS) * Math.PI) : 0;
  const waiting = anim.waiting;
  const breath = waiting ? (1 - Math.cos(((now - waiting.since) / WAIT_BREATH_MS) * Math.PI * 2)) / 2 : 0;
  return Array.from({ length: LADDER_RUNGS }, (_, index) => {
    const lit = rung !== null && index <= rung;
    const wasLit = from !== null && index <= from;
    let color: Rgb = lit ? palette.fg : unlit;
    // The segment gained lights up and cools; the one lost fades out.
    if (lit && !wasLit) color = mix(LIGHT, palette.fg, change);
    if (!lit && wasLit) color = mix(palette.fg, unlit, change);
    if (waiting) {
      // Still the running rungs, but on their way out; the ones the switch adds or drops breathe.
      if (lit) color = mix(color, unlit, 0.5);
      const target = waiting.rung;
      if (target !== null && !lit && index <= target) color = mix(unlit, LIGHT, 0.15 + 0.75 * breath);
      if (target !== null && lit && index > target) color = mix(dimmed, unlit, breath);
    } else if (cue && lit) {
      // Nowhere further to go: the meter swells once at the top, sags once at the bottom.
      color = cue.dir > 0 ? mix(palette.fg, LIGHT, bump) : mix(palette.fg, unlit, 0.7 * bump);
    }
    return { ch: LADDER_METER_GLYPH, rgb: mix(mix(color, palette.bg, fade), palette.bg, 1 - appear) };
  });
}

/** A switch the daemon refused: the label flushes red and cools off. */
function refusedTint(anim: LadderAnimation, cells: LadderCell[], now: number, palette: LadderPalette): LadderCell[] {
  const cue = anim.cue;
  if (cue?.kind !== "refused") return cells;
  const t = (now - cue.startAt) / CUE_MS;
  if (t >= 1) return cells;
  return cells.map(cell => cell.ch === " " ? cell : { ch: cell.ch, rgb: mix(cell.rgb ?? palette.fg, REFUSED, (1 - t) * 0.85) });
}

/**
 * The bar's right-hand segment at `now`: meter, a space, the label in its slot,
 * a trailing space. `available` is how many cells the bar can give it; the
 * meter goes first when there is no room. Null once the animation is over.
 */
export function renderLadderSegment(
  anim: LadderAnimation,
  label: string,
  now: number,
  palette: LadderPalette,
  available: number,
): LadderSegment | null {
  const lateFrame = now - anim.lastFrameAt > LADDER_LATE_FRAME_MS;
  anim.lastFrameAt = now;
  if (lateFrame && anim.morph) anim.morph = null;
  if (ladderAnimationDone(anim, now)) return null;
  anim.slot = Math.max(anim.slot, Array.from(label).length);

  anim.since ??= now;
  const cells = refusedTint(anim, morphCells(anim, label, now, palette), now, palette);
  // A blank either side keeps the label off the meter and off the bar's edge.
  const blank: LadderCell = { ch: " ", rgb: null };
  const labelRow: LadderCell[] = [blank, ...cells, blank];
  const meter = meterCells(anim, now, palette);
  let row: LadderCell[] = [...meter, ...labelRow];
  if (row.length > available) row = labelRow;
  if (row.length > available) return null;
  return { text: styledCells(row, palette.level, palette.rest), width: row.length };
}
