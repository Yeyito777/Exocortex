import { describe, expect, test } from "bun:test";
import type { StreamOptions } from "../types";
import { agentTurnOptions } from "./api";

describe("Claude Code turn options", () => {
  test("disallow Claude Code's own subagent tool and schedulers, leaving delegation to exo and chrono", () => {
    const options = agentTurnOptions(
      "claude-opus-5-5" as never,
      { system: "" } as StreamOptions,
      "/work",
      { pending: [] } as never,
      () => {},
      async () => { throw new Error("unused"); },
      "main",
    );
    expect(options.disallowedTools).toEqual(expect.arrayContaining(["Agent", "Task", "AskUserQuestion", "ScheduleWakeup"]));
  });
});
