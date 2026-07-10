import { beforeEach, describe, expect, test } from "bun:test";
import { appendToStreamingBlock, clearActiveJob, clearCurrentStreamingBlocks, getContextCompactionStartedAt, getCurrentStreamingBlocks, getStreamSeq, initStreamingState, nextStreamSeq, setActiveJob, setContextCompactionStartedAt } from "./streaming";

const IDS: string[] = [];

function mkId(suffix: string): string {
  const id = `streaming-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  IDS.push(id);
  return id;
}

beforeEach(() => {
  for (const id of IDS.splice(0)) clearActiveJob(id);
});

describe("stream event sequence", () => {
  test("increments during an active stream and resets on the next active job", () => {
    const id = mkId("seq");
    setActiveJob(id, new AbortController(), 1);

    expect(getStreamSeq(id)).toBe(0);
    expect(nextStreamSeq(id)).toBe(1);
    expect(nextStreamSeq(id)).toBe(2);
    expect(getStreamSeq(id)).toBe(2);

    clearActiveJob(id);
    expect(getStreamSeq(id)).toBe(0);

    setActiveJob(id, new AbortController(), 2);
    expect(nextStreamSeq(id)).toBe(1);
  });
});

describe("context compaction status", () => {
  test("is ephemeral and cleared with the active job", () => {
    const id = mkId("compaction-status");
    setActiveJob(id, new AbortController(), 1);
    setContextCompactionStartedAt(id, 42);
    expect(getContextCompactionStartedAt(id)).toBe(42);

    clearActiveJob(id);
    expect(getContextCompactionStartedAt(id)).toBeUndefined();
  });
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

  test("continues capturing chunks after the current round is cleared while streaming", () => {
    const id = mkId("round-reset");
    setActiveJob(id, new AbortController(), Date.now());
    initStreamingState(id);

    appendToStreamingBlock(id, "text", "round one tail");
    clearCurrentStreamingBlocks(id);
    appendToStreamingBlock(id, "text", "round two tail");

    expect(getCurrentStreamingBlocks(id)).toEqual([
      { type: "text", text: "round two tail" },
    ]);

    clearActiveJob(id);
    clearCurrentStreamingBlocks(id);
    expect(getCurrentStreamingBlocks(id)).toBeUndefined();
  });
});
