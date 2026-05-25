import { describe, expect, test } from "bun:test";
import { GOAL_COMMAND } from "./goal";
import { createInitialState } from "../state";

describe("/goal command", () => {
  test("parses pausable and completable flags when setting a goal", () => {
    expect(GOAL_COMMAND.handler("/goal pausable=false completable=true finish the task", createInitialState())).toEqual({
      type: "goal",
      action: "set",
      objective: "finish the task",
      pausable: false,
      completable: true,
    });
  });

  test("parses the unpausable/uncompletable alias when setting a goal", () => {
    expect(GOAL_COMMAND.handler("/goal unpausable/uncompletable finish the task", createInitialState())).toEqual({
      type: "goal",
      action: "set",
      objective: "finish the task",
      pausable: false,
      completable: false,
    });
  });

  test("exposes simple unpausable and uncompletable completions", () => {
    expect(GOAL_COMMAND.args?.map(arg => arg.name)).toContain("unpausable");
    expect(GOAL_COMMAND.args?.map(arg => arg.name)).toContain("uncompletable");
    expect(GOAL_COMMAND.args?.map(arg => arg.name)).not.toContain("pausable=false");
    expect(GOAL_COMMAND.args?.map(arg => arg.name)).not.toContain("completable=false");
  });

  test("user can manually complete goals from the TUI command", () => {
    expect(GOAL_COMMAND.handler("/goal complete", createInitialState())).toEqual({
      type: "goal",
      action: "complete",
    });
  });

  test("completable=false forces pausable=false in the UI command result", () => {
    expect(GOAL_COMMAND.handler("/goal pausable=true completable=false keep working", createInitialState())).toEqual({
      type: "goal",
      action: "set",
      objective: "keep working",
      pausable: false,
      completable: false,
    });
  });
});
