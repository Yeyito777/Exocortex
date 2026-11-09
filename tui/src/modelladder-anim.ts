/**
 * The model ladder's top-bar animation (Shift+Up / Shift+Down).
 *
 * Pure frame composition: given the animation record, the label to show and
 * the time, build the right-hand segment of the top bar. The label re-forms
 * cell by cell in a sweep (left to right going up, right to left going down);
 * changed cells fill up from the bottom (or drain down) through block glyphs
 * in a warm or cool wash and settle to their resting colour. A five-rung
 * meter beside it lights the current rung and fades a second after the last
 * press. When everything has played out the segment is null and the top bar
 * renders exactly as it does without the ladder.
 *
 * A model switch asked for mid-turn waits for the turn to end. Meanwhile the
 * label rests dimmed on the model it will switch to, the meter stays up with
 * the running rung half lit and the target rung breathing, until the switch
 * lands and the label brightens back to normal.
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
}

export const LADDER_RUNG_GLYPHS = ["▁", "▂", "▄", "▆", "█"] as const;

/** Sweep across the label, then each cell's glyph run, then its colour settling. */
export const MORPH_SWEEP_MS = 190;
export const MORPH_SCRAMBLE_MS = 150;
export const MORPH_SETTLE_MS = 120;
export const MORPH_TOTAL_MS = MORPH_SWEEP_MS + MORPH_SCRAMBLE_MS + MORPH_SETTLE_MS;
export const CUE_MS = 380;
export const METER_HOLD_MS = 1000;
export const METER_FADE_MS = 280;
export const RUNG_FLARE_MS = 260;
export const LADDER_FRAME_MS = 16;
/** The waiting rung breathes this slowly, drawn at this frame interval. */
export const WAIT_BREATH_MS = 1800;
export const WAIT_FRAME_MS = 90;
/** A frame this late means timers cannot drive the animation: show the result. */
export const LADDER_LATE_FRAME_MS = 150;

// Going up a cell fills from the bottom and dissolves into the new letter;
// going down it condenses and drains away downward.
const FILL_UP = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█", "▓", "▒", "░"];
const FILL_DOWN = ["░", "▒", "▓", "█", "▇", "▆", "▅", "▄", "▃", "▂", "▁"];

const WARM_START: Rgb = [255, 138, 61];
const WARM_PEAK: Rgb = [255, 226, 122];
const WARM_GLOW: Rgb = [255, 246, 214];
const COOL_START: Rgb = [214, 243, 255];
const COOL_PEAK: Rgb = [13, 59, 110];
const REFUSED: Rgb = [255, 92, 92];

export interface LadderPalette {
  /** Top bar background. */
  bg: Rgb;
  /** Normal label colour (what cells settle toward before going back to the default). */
  fg: Rgb;
  level: TerminalColorLevel;
}

export interface LadderSegment {
  /** Styled text; leaves the bar's background in place and ends on the default foreground. */
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
  return !anim.morph || now - anim.morph.startAt >= MORPH_TOTAL_MS;
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

function scrambleGlyph(dir: LadderDirection, t: number): string {
  const run = dir > 0 ? FILL_UP : FILL_DOWN;
  return run[Math.min(run.length - 1, Math.floor(t * run.length))];
}

function morphCells(anim: LadderAnimation, label: string, now: number, palette: LadderPalette): LadderCell[] {
  const rest = anim.waiting ? waitingRgb(palette) : null;
  const target = alignRight(labelCells(label, rest), anim.slot);
  const morph = anim.morph;
  if (!morph || now - morph.startAt >= MORPH_TOTAL_MS) return target;
  const from = alignRight(morph.from, anim.slot);
  const elapsed = now - morph.startAt;
  const last = Math.max(1, anim.slot - 1);
  const up = morph.dir > 0;
  const restRgb = rest ?? palette.fg;
  return target.map((to, column) => {
    const was = from[column];
    const order = up ? column : anim.slot - 1 - column;
    const t = elapsed - (order / last) * MORPH_SWEEP_MS;
    if (t < 0) return was;
    const same = was.ch === to.ch;
    if (same && to.ch === " ") return to;
    if (t < MORPH_SCRAMBLE_MS) {
      const k = t / MORPH_SCRAMBLE_MS;
      if (same) {
        // Unchanged text only feels the wash pass over it.
        const peak = up ? WARM_PEAK : COOL_PEAK;
        return { ch: to.ch, rgb: mix(was.rgb ?? palette.fg, peak, Math.sin(k * Math.PI) * 0.85) };
      }
      return {
        ch: scrambleGlyph(morph.dir, k),
        rgb: up ? mix(WARM_START, WARM_PEAK, k) : mix(COOL_START, COOL_PEAK, k),
      };
    }
    const settle = (t - MORPH_SCRAMBLE_MS) / MORPH_SETTLE_MS;
    if (settle >= 1 || same) return to;
    return { ch: to.ch, rgb: mix(up ? WARM_GLOW : COOL_PEAK, restRgb, easeOut(settle)) };
  });
}

function fg(rgb: Rgb, level: TerminalColorLevel): string {
  return rgbToAnsi(38, rgb[0], rgb[1], rgb[2], level);
}

const DEFAULT_FG = "\x1b[39m";

function styledCells(cells: LadderCell[], level: TerminalColorLevel): string {
  let out = "";
  let current: string = DEFAULT_FG;
  for (const cell of cells) {
    const color = cell.rgb ? fg(cell.rgb, level) : DEFAULT_FG;
    if (color !== current) {
      out += color;
      current = color;
    }
    out += cell.ch;
  }
  if (current !== DEFAULT_FG) out += DEFAULT_FG;
  return out;
}

function meterCells(anim: LadderAnimation, now: number, palette: LadderPalette): LadderCell[] {
  const fadeStart = anim.lastPressAt + METER_HOLD_MS;
  const fade = anim.waiting || now <= fadeStart ? 0 : (now - fadeStart) / METER_FADE_MS;
  const unlit = mix(palette.bg, [0, 0, 0], 0.38);
  const cue = anim.cue && now - anim.cue.startAt < CUE_MS ? anim.cue : null;
  const cueT = cue ? (now - cue.startAt) / CUE_MS : 0;
  const waiting = anim.waiting;
  return LADDER_RUNG_GLYPHS.map((ch, index) => {
    let color: Rgb = unlit;
    if (index === anim.rung) {
      const flare = Math.max(0, 1 - (now - anim.rungAt) / RUNG_FLARE_MS);
      const wash = anim.morph?.dir === -1 ? COOL_START : WARM_PEAK;
      color = mix(palette.fg, wash, flare);
      // Still the running rung, but on its way out.
      if (waiting) color = mix(color, unlit, 0.55);
    }
    if (waiting && index === waiting.rung) {
      // The rung it switches to breathes until the turn ends.
      const breath = (1 - Math.cos(((now - waiting.since) / WAIT_BREATH_MS) * Math.PI * 2)) / 2;
      color = mix(mix(unlit, palette.fg, 0.35), waiting.dir > 0 ? WARM_PEAK : COOL_START, breath);
    }
    if (cue?.kind === "end" && index === anim.rung && !waiting) {
      // Two quick pulses on the end rung: there is nowhere further to go.
      const pulse = Math.abs(Math.sin(cueT * Math.PI * 2));
      color = mix(palette.fg, cue.dir > 0 ? WARM_START : COOL_PEAK, pulse);
    }
    return { ch, rgb: mix(color, palette.bg, fade) };
  });
}

/** Horizontal shake of the label when the daemon refuses a switch (cells, -1…1). */
function refusedShake(anim: LadderAnimation, now: number): number {
  const cue = anim.cue;
  if (cue?.kind !== "refused") return 0;
  const t = now - cue.startAt;
  if (t >= CUE_MS) return 0;
  const steps = [1, -1, 1, -1, 1, 0];
  return steps[Math.min(steps.length - 1, Math.floor((t / CUE_MS) * steps.length))];
}

/** Refused: the label flushes red and cools off. At the end of the ladder: a faint pulse with the rung. */
function cueTint(anim: LadderAnimation, cells: LadderCell[], now: number, palette: LadderPalette): LadderCell[] {
  const cue = anim.cue;
  if (!cue) return cells;
  const t = (now - cue.startAt) / CUE_MS;
  if (t >= 1) return cells;
  const color = cue.kind === "refused" ? REFUSED : cue.dir > 0 ? WARM_START : COOL_PEAK;
  const strength = cue.kind === "refused" ? (1 - t) * 0.9 : Math.abs(Math.sin(t * Math.PI * 2)) * 0.35;
  return cells.map(cell => cell.ch === " " ? cell : { ch: cell.ch, rgb: mix(cell.rgb ?? palette.fg, color, strength) });
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

  let cells = morphCells(anim, label, now, palette);
  cells = cueTint(anim, cells, now, palette);
  const shake = refusedShake(anim, now);
  // Room for the shake: one cell either side of the slot.
  const blank: LadderCell = { ch: " ", rgb: null };
  const labelRow: LadderCell[] = [blank, ...cells, blank];
  if (shake > 0) { labelRow.pop(); labelRow.unshift(blank); }
  if (shake < 0) { labelRow.shift(); labelRow.push(blank); }
  const meter = meterCells(anim, now, palette);
  let row: LadderCell[] = [...meter, ...labelRow];
  if (row.length > available) row = labelRow;
  if (row.length > available) return null;
  return { text: styledCells(row, palette.level), width: row.length };
}
