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
