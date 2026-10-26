/**
 * Dev-only main-thread stall profiler: EXOCORTEX_PROFILE_STALLS=FILE writes, on
 * exit, every blocking stretch the event loop saw (a 2 ms interval that fired
 * late) and every labelled span (daemon event, render, input, wire parse) that
 * held the thread for 8 ms or more. Off, every call is a plain passthrough.
 */
import { writeFileSync } from "node:fs";

const OUT = process.env.EXOCORTEX_PROFILE_STALLS;
const SPAN_MIN_MS = 8;
const TICK_MS = 2;
const STALL_MIN_MS = 16;

interface Span { at: number; ms: number; label: string; parent: string | null }
interface Stall { at: number; ms: number; labels: string[] }

const spans: Span[] = [];
const stalls: Stall[] = [];
const stack: string[] = [];
/** Labels whose spans ended since the last tick: what the stall was made of. */
let sinceTick: string[] = [];
const marks: Array<{ at: number; mark: string }> = [];

export const STALL_PROFILE = !!OUT;

export function stallSpan<T>(label: string, fn: () => T): T {
  if (!OUT) return fn();
  const parent = stack.at(-1) ?? null;
  stack.push(label);
  const at = performance.now();
  try {
    return fn();
  } finally {
    stack.pop();
    const ms = performance.now() - at;
    if (ms >= SPAN_MIN_MS) {
      spans.push({ at: round(at), ms: round(ms), label, parent });
      if (!parent) sinceTick.push(`${label}:${Math.round(ms)}`);
    }
  }
}

export function stallMark(mark: string): void {
  if (OUT) marks.push({ at: round(performance.now()), mark });
}

function round(ms: number): number { return Math.round(ms * 10) / 10; }

if (OUT) {
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const gap = now - last - TICK_MS;
    if (gap >= STALL_MIN_MS) stalls.push({ at: round(last), ms: round(gap), labels: sinceTick });
    sinceTick = [];
    last = now;
  }, TICK_MS).unref?.();
  process.on("exit", () => {
    writeFileSync(OUT, JSON.stringify({ stalls, spans, marks }) + "\n");
  });
}
