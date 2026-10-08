import { expect, test } from "bun:test";
import { FirstTextUX } from "./first-text";

test("first real text bypasses batching and measures submit to actual frame, not response.created", () => {
  let now = 100;
  const timings: unknown[] = [];
  const ux = new FirstTextUX(value => timings.push(value), () => now);
  ux.start("c", 123);
  now = 150;
  expect(ux.onText("c", 123, " \n")).toBe(false);
  now = 200;
  expect(ux.onText("c", 123, "Hello")).toBe(true);
  now = 202;
  ux.onFrame("c", 123);
  ux.onFrame("c", 123);
  expect(ux.onText("c", 123, " more")).toBe(false);
  expect(timings).toEqual([{ convId: "c", startedAt: 123, receivedMs: 100, renderedMs: 102, receiveToRenderMs: 2 }]);
  ux.start("c", 456);
  expect(ux.onText("c", 456, "next turn")).toBe(true);
});

test("late joins do not invent a submit clock; unrelated frames cannot complete a measurement", () => {
  const timings: unknown[] = [];
  const ux = new FirstTextUX(value => timings.push(value));
  expect(ux.onText("late", 123, "hello")).toBe(true);
  ux.onFrame("other", 123);
  ux.onFrame("late", 123);
  expect(timings).toEqual([]);
});

test("profiling-disabled first-text handling never reads the measurement clock", () => {
  const ux = new FirstTextUX(undefined, () => { throw new Error("unexpected clock"); });
  ux.start("c", 1);
  expect(ux.onText("c", 1, "hello")).toBe(true);
  ux.onFrame("c", 1);
});
