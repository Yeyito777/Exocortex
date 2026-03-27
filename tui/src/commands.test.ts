/**
 * Tests for slash-command behavior.
 */

import { describe, expect, test } from "bun:test";
import { tryCommand } from "./commands";
import { createInitialState } from "./state";

describe("/instructions", () => {
  test("on a new chat with text, stages instructions and requests conversation creation", () => {
    const state = createInitialState();

    const result = tryCommand("/instructions be concise", state);

    expect(result).toEqual({ type: "new_conversation" });
    expect(state.pendingSystemInstructions).toBe("be concise");
    expect(state.pendingGenerateTitleOnCreate).toBe(false);
    expect(state.messages).toHaveLength(0);
  });

  test("on a new chat with no text, reports that no instructions are set", () => {
    const state = createInitialState();

    const result = tryCommand("/instructions", state);

    expect(result).toEqual({ type: "handled" });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      role: "system",
      text: "No system instructions set for this conversation.",
    });
  });

  test("on a new chat with clear, does not create a conversation", () => {
    const state = createInitialState();

    const result = tryCommand("/instructions clear", state);

    expect(result).toEqual({ type: "handled" });
    expect(state.pendingSystemInstructions).toBeNull();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      role: "system",
      text: "No system instructions set for this conversation.",
    });
  });
});
