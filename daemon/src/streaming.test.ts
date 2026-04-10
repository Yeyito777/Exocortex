import { beforeEach, describe, expect, test } from "bun:test";
import { appendToStreamingBlock, clearActiveJob, getCurrentStreamingBlocks, initStreamingState, setActiveJob } from "./streaming";

const IDS: string[] = [];

function mkId(suffix: string): string {
  const id = `streaming-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  IDS.push(id);
  return id;
}

beforeEach(() => {
  for (const id of IDS.splice(0)) clearActiveJob(id);
});

describe("appendToStreamingBlock", () => {
  test("creates a new block when a stream resumes after a different block type", () => {
    const id = mkId("resume");
    setActiveJob(id, new AbortController(), Date.now());
    initStreamingState(id);

    appendToStreamingBlock(id, "text", "First paragraph.\n\n");
    appendToStreamingBlock(id, "thinking", "Thinking...");
    appendToStreamingBlock(id, "text", "Second paragraph.");

    expect(getCurrentStreamingBlocks(id)).toEqual([
      { type: "text", text: "First paragraph.\n\n" },
      { type: "thinking", text: "Thinking..." },
      { type: "text", text: "Second paragraph." },
    ]);
  });
});
