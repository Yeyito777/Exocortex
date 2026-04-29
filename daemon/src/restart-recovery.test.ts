import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import {
  clearInterruptedStreamIds,
  interruptedStreamsPath,
  readInterruptedStreamIds,
  writeInterruptedStreamIds,
} from "./restart-recovery";

afterEach(() => {
  clearInterruptedStreamIds();
});

describe("restart recovery file", () => {
  test("writes and reads a deduplicated interrupted stream list", () => {
    const written = writeInterruptedStreamIds(["conv-a", "conv-b", "conv-a", "  ", "conv-c"]);

    expect(written).toEqual(["conv-a", "conv-b", "conv-c"]);
    expect(readInterruptedStreamIds()).toEqual(["conv-a", "conv-b", "conv-c"]);

    const payload = JSON.parse(readFileSync(interruptedStreamsPath(), "utf-8"));
    expect(payload).toMatchObject({
      version: 1,
      reason: "restart",
      convIds: ["conv-a", "conv-b", "conv-c"],
    });
    expect(typeof payload.createdAt).toBe("number");
  });

  test("empty writes clear the recovery file", () => {
    writeInterruptedStreamIds(["conv-a"]);
    expect(existsSync(interruptedStreamsPath())).toBe(true);

    writeInterruptedStreamIds([]);
    expect(existsSync(interruptedStreamsPath())).toBe(false);
    expect(readInterruptedStreamIds()).toEqual([]);
  });
});
