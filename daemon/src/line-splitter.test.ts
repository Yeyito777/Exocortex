import { expect, test } from "bun:test";
import { LineSplitter } from "./line-splitter";

function split(chunks: string[]): string[] {
  const splitter = new LineSplitter();
  const lines: string[] = [];
  for (const chunk of chunks) splitter.push(chunk, line => lines.push(line));
  return lines;
}

test("frames lines across every chunk boundary", () => {
  const text = "first\n\nsecond line\nthird\npartial";
  for (let a = 0; a <= text.length; a++) {
    for (let b = a; b <= text.length; b++) {
      expect(split([text.slice(0, a), text.slice(a, b), text.slice(b)])).toEqual(["first", "", "second line", "third"]);
    }
  }
});

test("a long line in small chunks costs linear time", () => {
  const line = "x".repeat(20_000_000);
  const chunks: string[] = [];
  for (let i = 0; i < line.length; i += 65_536) chunks.push(line.slice(i, i + 65_536));
  chunks.push("\n");
  const started = performance.now();
  const lines = split(chunks);
  // Rescanning the accumulated text took ~600 ms here; a linear scan takes ~10 ms.
  expect(performance.now() - started).toBeLessThan(250);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toHaveLength(line.length);
});
