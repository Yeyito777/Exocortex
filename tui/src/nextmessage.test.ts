import { describe, expect, test } from "bun:test";
import { handleFocusedKey } from "./focus";
import { handleEvent } from "./events";
import { parseInput } from "./input";
import { invalidateFrame } from "./frame";
import { createPendingAI } from "./messages";
import { render } from "./render";
import { createInitialState, type RenderState } from "./state";
import { TerminalControlBuffer } from "./terminalclipboard";

function stateWithSuggestion(text = "commit and push it"): RenderState {
  const state = createInitialState();
  state.cols = 120;
  state.rows = 30;
  state.convId = "conv-1";
  handleEvent({ type: "next_message_suggestion", convId: "conv-1", text }, state, {} as never);
  return state;
}

function renderedText(state: RenderState): string {
  let out = "";
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    invalidateFrame(state);
    render(state);
  } finally {
    process.stdout.write = write as typeof process.stdout.write;
  }
  return out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

describe("Right Shift input", () => {
  test("st's OSC, Mac Terminal's fallback and xterm F20 parse as keys", () => {
    expect(parseInput("\x1b]777;right-shift\x07")).toEqual([{ type: "right-shift" }]);
    expect(parseInput("\x1b]777;right-shift\x1b\\a")).toEqual([{ type: "right-shift" }, { type: "char", char: "a" }]);
    expect(parseInput("\x1b[29~")).toEqual([{ type: "right-shift" }]);
    expect(parseInput("\x1b[19;2~")).toEqual([{ type: "f20" }]);
  });

  test("the terminal-reply buffer passes st's Right Shift through as input", () => {
    const input: string[] = [];
    const controls: string[] = [];
    const buffer = new TerminalControlBuffer(data => input.push(data), sequence => controls.push(sequence));
    buffer.feed("a\x1b]777;rig");
    buffer.feed("ht-shift\x07b");
    expect(input.join("")).toBe("a\x1b]777;right-shift\x07b");
    expect(controls).toEqual([]);
    buffer.dispose();
  });
});

describe("next-message suggestion", () => {
  test("shows as ghost text in the empty prompt and vanishes once anything is typed", () => {
    const state = stateWithSuggestion();
    expect(renderedText(state)).toContain("commit and push it");
    handleFocusedKey({ type: "char", char: "n" }, state);
    expect(state.inputBuffer).toBe("n");
    expect(renderedText(state)).not.toContain("commit and push it");
  });

  for (const key of [{ type: "right-shift" }, { type: "right" }, { type: "f20" }] as const) {
    test(`${key.type} puts it in the prompt for editing without sending it`, () => {
      const state = stateWithSuggestion();
      expect(handleFocusedKey(key, state)).toEqual({ type: "handled" });
      expect(state.inputBuffer).toBe("commit and push it");
      expect(state.cursorPos).toBe("commit and push it".length);
    });
  }

  test("normal mode: F20 stays st's Ctrl+7 sidebar shortcut; Right Shift still accepts", () => {
    const state = stateWithSuggestion();
    state.vim.mode = "normal";
    handleFocusedKey({ type: "f20" }, state);
    expect(state.inputBuffer).toBe("");
    state.panelFocus = "chat";
    state.chatFocus = "prompt";
    handleFocusedKey({ type: "right-shift" }, state);
    expect(state.inputBuffer).toBe("commit and push it");
    expect(state.cursorPos).toBe("commit and push it".length - 1);
  });

  test("hidden while streaming, for another conversation, and after a new turn starts", () => {
    const state = stateWithSuggestion();
    state.pendingAI = createPendingAI(Date.now(), "claude-opus-5-5");
    expect(renderedText(state)).not.toContain("commit and push it");
    handleFocusedKey({ type: "right" }, state);
    expect(state.inputBuffer).toBe("");
    state.pendingAI = null;

    state.convId = "conv-2";
    expect(renderedText(state)).not.toContain("commit and push it");
    state.convId = "conv-1";

    handleEvent({ type: "streaming_started", convId: "conv-1", provider: "anthropic", model: "claude-opus-5-5", startedAt: Date.now() }, state, {} as never);
    expect(state.nextMessageSuggestion).toBeNull();
  });

  test("a null event clears it; events for other conversations are ignored", () => {
    const state = stateWithSuggestion();
    handleEvent({ type: "next_message_suggestion", convId: "conv-2", text: "other" }, state, {} as never);
    expect(state.nextMessageSuggestion?.text).toBe("commit and push it");
    handleEvent({ type: "next_message_suggestion", convId: "conv-1", text: null }, state, {} as never);
    expect(state.nextMessageSuggestion).toBeNull();
  });
});
