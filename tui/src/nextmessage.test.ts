import { describe, expect, test } from "bun:test";
import { handleFocusedKey } from "./focus";
import { handleEvent } from "./events";
import { parseInput, type KeyEvent } from "./input";
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

describe("next-message suggestion", () => {
  test("shows as ghost text in the empty prompt and vanishes once anything is typed", () => {
    const state = stateWithSuggestion();
    expect(renderedText(state)).toContain("commit and push it");
    handleFocusedKey({ type: "char", char: "n" }, state);
    expect(state.inputBuffer).toBe("n");
    expect(renderedText(state)).not.toContain("commit and push it");
  });

  for (const mode of ["insert", "normal"] as const) {
    for (const key of [{ type: "tab" }, { type: "right" }] as const) {
      test(`${mode}-mode ${key.type} puts it in the prompt for editing without sending it`, () => {
        const state = stateWithSuggestion();
        state.vim.mode = mode;
        expect(handleFocusedKey(key, state)).toEqual({ type: "handled" });
        expect(state.inputBuffer).toBe("commit and push it");
        expect(state.cursorPos).toBe("commit and push it".length - (mode === "normal" ? 1 : 0));
        expect(state.vim.mode).toBe(mode);
      });
    }
  }

  test("insert-mode Tab keeps its soft tab when no suggestion shows or the prompt is not empty", () => {
    const none = stateWithSuggestion();
    none.nextMessageSuggestion = null;
    handleFocusedKey({ type: "tab" }, none);
    expect(none.inputBuffer).toBe("    ");

    const typed = stateWithSuggestion();
    handleFocusedKey({ type: "char", char: "x" }, typed);
    handleFocusedKey({ type: "tab" }, typed);
    expect(typed.inputBuffer).toBe("x    ");
  });

  test("Right Shift no longer accepts: st's OSC is dropped, F20 is Ctrl+7 and CSI 29~ does nothing", () => {
    // The terminal-reply buffer in front of the parser drops st's OSC, as before suggestions.
    const input: string[] = [];
    const buffer = new TerminalControlBuffer(data => input.push(data), () => {});
    buffer.feed("a\x1b]777;right-shift\x07b");
    expect(input.join("")).toBe("ab");
    buffer.dispose();

    for (const mode of ["insert", "normal"] as const) {
      for (const sequence of ["\x1b[19;2~", "\x1b[29~"]) {
        const state = stateWithSuggestion();
        state.vim.mode = mode;
        state.sidebar.open = false;
        for (const key of parseInput(sequence) as KeyEvent[]) handleFocusedKey(key, state);
        expect(state.inputBuffer).toBe("");
      }
    }
    // F20 (st's Ctrl+7) jumps to the sidebar in normal mode even with a suggestion showing.
    const state = stateWithSuggestion();
    state.vim.mode = "normal";
    state.sidebar.open = false;
    handleFocusedKey({ type: "f20" }, state);
    expect(state.sidebar.open).toBe(true);
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
