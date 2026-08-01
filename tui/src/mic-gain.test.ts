import { describe, expect, test } from "bun:test";
import { readExocortexConfig, writeExocortexConfig } from "@exocortex/shared/config";
import {
  formatMicGainDb,
  loadMicGainDb,
  parseMicGainDb,
  saveMicGainDb,
} from "./mic-gain";

describe("microphone gain", () => {
  test("parses and formats decibel values", () => {
    expect(parseMicGainDb("-12")).toBe(-12);
    expect(parseMicGainDb("+3.5dB")).toBe(3.5);
    expect(parseMicGainDb("reset")).toBe(0);
    expect(parseMicGainDb("loud")).toBeNull();
    expect(formatMicGainDb(-3.5)).toBe("-3.5dB");
  });

  test("persists gain in the shared TUI config", () => {
    const previous = readExocortexConfig();
    try {
      expect(saveMicGainDb(-7.5)).toBe(-7.5);
      expect(loadMicGainDb()).toBe(-7.5);
      expect(readExocortexConfig().audio?.micGainDb).toBe(-7.5);
    } finally {
      writeExocortexConfig(previous);
    }
  });
});
