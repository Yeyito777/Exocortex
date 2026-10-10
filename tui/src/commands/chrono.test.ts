import { describe, expect, test } from "bun:test";
import { CHRONO_COMMAND } from "./chrono";
import { CHRONO_USAGE } from "../chronoschedule";
import { createInitialState } from "../state";

describe("/chrono command", () => {
  test("sends parsed requests and keeps a mistyped prompt for fixing", () => {
    expect(CHRONO_COMMAND.handler("/chrono", createInitialState())).toEqual({ type: "chrono", request: { action: "list" } });
    expect(CHRONO_COMMAND.handler("/chrono cancel all", createInitialState())).toEqual({
      type: "chrono", request: { action: "cancel", scheduleId: "all" },
    });
    const state = createInitialState();
    expect(CHRONO_COMMAND.handler("/chrono every 30s x", state)).toEqual({ type: "handled" });
    expect(state.messages.at(-1)).toEqual(expect.objectContaining({ text: expect.stringContaining("whole minutes") }));
  });

  test("shows the syntax for help", () => {
    const state = createInitialState();
    expect(CHRONO_COMMAND.handler("/chrono help", state)).toEqual({ type: "handled" });
    expect(state.messages.at(-1)).toEqual(expect.objectContaining({ text: CHRONO_USAGE }));
  });
});
