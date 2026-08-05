import { afterEach, describe, expect, test } from "bun:test";
import { handleFocusedKey } from "../focus";
import { createInitialState } from "../state";
import { pasteFromClipboard, setTextClipboardSystemForTest } from "./clipboard";

describe("text clipboard", () => {
  afterEach(() => setTextClipboardSystemForTest(null));

  test("visual y copies highlighted history text to the macOS pasteboard with pbcopy", () => {
    const copies: Array<{ command: string[]; text: string }> = [];
    const state = createInitialState();
    state.panelFocus = "chat";
    state.chatFocus = "history";
    state.vim.mode = "visual";
    state.historyLines = ["selected history text"];
    state.historyWrapContinuation = [false];
    state.historyWrapJoiners = [""];
    state.historyVisualAnchor = { row: 0, col: 0 };
    state.historyCursor = { row: 0, col: "selected history text".length - 1 };
    state.layout.totalLines = 1;
    state.layout.messageAreaHeight = 1;

    setTextClipboardSystemForTest({
      platform: "darwin",
      env: {},
      commandExists: command => command === "pbcopy" || command === "pbpaste",
      copy: (command, text) => {
        copies.push({ command, text });
        return Promise.resolve(0);
      },
    });

    expect(handleFocusedKey({ type: "char", char: "y" }, state)).toEqual({ type: "handled" });
    expect(state.vim.mode as string).toBe("normal");
    expect(copies).toEqual([{
      command: ["pbcopy"],
      text: "selected history text",
    }]);
  });

  test("reads text from the macOS pasteboard with pbpaste", async () => {
    const commands: string[][] = [];

    setTextClipboardSystemForTest({
      platform: "darwin",
      env: {},
      commandExists: command => command === "pbcopy" || command === "pbpaste",
      paste: (command) => {
        commands.push(command);
        return Promise.resolve({ output: "mac clipboard text", exitCode: 0 });
      },
    });

    await expect(pasteFromClipboard()).resolves.toBe("mac clipboard text");
    expect(commands).toEqual([["pbpaste"]]);
  });

  test("visual y copies highlighted history text to the Windows clipboard with PowerShell", () => {
    const copies: Array<{ command: string[]; text: string }> = [];
    const state = createInitialState();
    state.panelFocus = "chat";
    state.chatFocus = "history";
    state.vim.mode = "visual";
    state.historyLines = ["selected Windows text 🪟"];
    state.historyWrapContinuation = [false];
    state.historyWrapJoiners = [""];
    state.historyVisualAnchor = { row: 0, col: 0 };
    state.historyCursor = { row: 0, col: "selected Windows text 🪟".length - 1 };
    state.layout.totalLines = 1;
    state.layout.messageAreaHeight = 1;

    setTextClipboardSystemForTest({
      platform: "win32",
      env: {},
      copy: (command, text) => {
        copies.push({ command, text });
        return Promise.resolve(0);
      },
    });

    expect(handleFocusedKey({ type: "char", char: "y" }, state)).toEqual({ type: "handled" });
    expect(state.vim.mode as string).toBe("normal");
    expect(copies).toHaveLength(1);
    expect(copies[0]?.command.slice(0, 5)).toEqual([
      "powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-Command",
    ]);
    expect(copies[0]?.command[5]).toContain("[System.Windows.Forms.Clipboard]::SetText($text)");
    expect(copies[0]?.text).toBe("selected Windows text 🪟");
  });

  test("reads UTF-8 text from the Windows clipboard with PowerShell", async () => {
    const commands: string[][] = [];

    setTextClipboardSystemForTest({
      platform: "win32",
      env: {},
      paste: (command) => {
        commands.push(command);
        return Promise.resolve({ output: "Windows clipboard café 漢字 🪟", exitCode: 0 });
      },
    });

    await expect(pasteFromClipboard()).resolves.toBe("Windows clipboard café 漢字 🪟");
    expect(commands).toHaveLength(1);
    expect(commands[0]?.slice(0, 5)).toEqual([
      "powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-Command",
    ]);
    expect(commands[0]?.[5]).toContain("[System.Windows.Forms.Clipboard]::GetText()");
  });
});
