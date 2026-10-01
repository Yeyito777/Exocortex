import { expect, test } from "bun:test";
import { RehydratedRenderCache } from "./rehydrated-render-cache";

test("rehydrated render cache evicts least recently used artifacts by count", () => {
  const cache = new RehydratedRenderCache<number>(1024, 2);
  cache.set("a", 1, 10);
  cache.set("b", 2, 10);
  expect(cache.get("a")).toBe(1);
  cache.set("c", 3, 10);
  expect(cache.get("b")).toBeUndefined();
  expect(cache.get("a")).toBe(1);
  expect(cache.get("c")).toBe(3);
});

test("rehydrated render cache bounds memory, including content keys", () => {
  const cache = new RehydratedRenderCache<number>(100, 100);
  for (const key of ["a", "b", "c", "d", "e"]) cache.set(key, 1, 20);
  expect(cache.get("a")).toBeUndefined();
  expect(cache.get("b")).toBe(1);
  // A single huge source/result cannot discard all the useful small entries.
  cache.set("oversized", 2, 100);
  expect(cache.get("oversized")).toBeUndefined();
  expect(cache.get("b")).toBe(1);
});

test("replacing a cached artifact releases the old budget", () => {
  const cache = new RehydratedRenderCache<number>(100, 100);
  for (let i = 0; i < 100; i++) cache.set("a", i, 20);
  cache.set("b", 1, 20);
  expect(cache.get("a")).toBe(99);
  expect(cache.get("b")).toBe(1);
});
