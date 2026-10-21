import { afterEach, describe, expect, test } from "bun:test";
import type { UserMacro } from "@exocortex/shared/user-macros";
import { MACRO_COMMAND, macroParseContext, tryCommand } from "../commands";
import { handleEvent } from "../events";
import { handleInstructionsModalKey } from "../instructions/controller";
import { expandMacros, getUserMacros, isMacroName, setUserMacros } from "../macros";
import { getPromptHighlightRanges } from "../prompthighlight";
import { render } from "../render";
import { commandCompletions, inlineSlashCompletions } from "../slashsearch";
import { createInitialState, type RenderState } from "../state";
import { TerminalScreen } from "../testhelpers/terminalscreen";
import { theme } from "../theme";
import { updateAutocomplete } from "../autocomplete";
import { invalidateFrame } from "../frame";
import { runUserMacroCommand, saveMacroFromEditor, userMacrosConnectionLost, type UserMacroDaemon } from "./controller";
import { expansionPreview, macroCompletions, macroGhostText, macroGuide, macroPopupRow } from "./guide";
import { parseMacroCommand, type MacroPartRole } from "./parse";
import { createUserMacroStore, receiveUserMacros, shownUserMacros, submitUserMacroChange, userMacrosConnectionLost as storeConnectionLost } from "./store";

afterEach(() => setUserMacros([]));

const BRIEF: UserMacro = { name: "/brief", expansion: "Answer in one short sentence.", description: "Answer briefly" };

function contextWith(macros: readonly UserMacro[]) {
  setUserMacros(macros);
  return macroParseContext();
}

function parse(buffer: string, macros: readonly UserMacro[] = [], cursor = buffer.length) {
  return parseMacroCommand(buffer, cursor, contextWith(macros))!;
}

/** A daemon double recording sends; answers are delivered by the test. */
function fakeDaemon(connected = true) {
  const sent: Array<{ reqId: string; op: "save" | "delete"; macro?: UserMacro; create?: boolean; name?: string }> = [];
  let next = 0;
  const daemon = {
    connected,
    subscribe() {}, unsubscribe() {}, sendMessage() {}, setSystemInstructions: () => "", loadToolOutputs() {},
    loadInstructions: () => "", setFolderInstructions: () => "", setGlobalInstructions: () => "",
    saveUserMacro(macro: UserMacro, create: boolean) { const reqId = `req-${++next}`; sent.push({ reqId, op: "save", macro, create }); return reqId; },
    deleteUserMacro(name: string) { const reqId = `req-${++next}`; sent.push({ reqId, op: "delete", name }); return reqId; },
  };
  return { sent, daemon };
}

/** A TUI that has heard the daemon's list. */
function connectedState(macros: readonly UserMacro[] = []) {
  const state = createInitialState();
  const { sent, daemon } = fakeDaemon();
  handleEvent({ type: "user_macros", macros: [...macros] }, state, daemon);
  return { state, sent, daemon };
}

/** Press Enter on a /macro prompt the way main.ts does. */
function enter(state: RenderState, daemon: UserMacroDaemon, text: string): void {
  state.inputBuffer = text;
  state.cursorPos = text.length;
  runUserMacroCommand(state, daemon, MACRO_COMMAND.handler(text, state));
}

function lastNotice(state: RenderState): string {
  return (state.messages.at(-1) as { text?: string } | undefined)?.text ?? "";
}


/** The rows of a full render: everything above the prompt's separator, and the prompt row. */
function renderRows(buffer: string, macros: readonly UserMacro[] = [BRIEF]) {
  const { state } = connectedState(macros);
  state.cols = 100;
  state.rows = 30;
  state.sidebar.open = false;
  state.inputBuffer = buffer;
  state.cursorPos = buffer.length;
  updateAutocomplete(state);
  let out = "";
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => { out += String(chunk); return true; }) as typeof process.stdout.write;
  try {
    invalidateFrame(state);
    render(state);
  } finally {
    process.stdout.write = write as typeof process.stdout.write;
  }
  const screen = new TerminalScreen(state.rows, state.cols);
  screen.feed(out);
  const rows = screen.plainRows();
  const prompt = rows.findIndex(row => row.startsWith("I > "));
  return { prompt: rows[prompt]!, above: rows.slice(2, prompt - 1).map(row => row.trimEnd()).filter(Boolean), out };
}

describe("/macro syntax", () => {
  test("add saves in one line: name, optional description, = and the text", () => {
    const plain = parse("/macro add /brief = Answer in one short sentence.");
    expect(plain).toMatchObject({ action: "add", error: null, incomplete: null, description: null });
    expect(plain.name!.text).toBe("/brief");
    expect(plain.expansion!.text).toBe("Answer in one short sentence.");

    const described = parse("/macro add /brief Answer briefly = Answer in one short sentence.");
    expect(described.description!.text).toBe("Answer briefly");
    expect(described.expansion!.text).toBe("Answer in one short sentence.");

    // Only the first = separates: the text may contain more, and span lines.
    const tricky = parse("/macro add /eq=a = b\nnext line");
    expect(tricky.name!.text).toBe("/eq");
    expect(tricky.description).toBeNull();
    expect(tricky.expansion!.text).toBe("a = b\nnext line");
  });

  test("definite mistakes are errors on the part that is wrong", () => {
    const cases: Array<[string, MacroPartRole, string]> = [
      ["/macro add /go = x", "name", "/go is a built-in macro"],
      ["/macro add /model = x", "name", "/model is a built-in command"],
      ["/macro add /effort = x", "name", "/effort is a built-in command"],
      ["/macro add brief = x", "name", "start with \"/\""],
      ["/macro add /a.b = x", "name", "letters, digits"],
      ["/macro add /brief = x", "name", "already exists; /macro edit /brief"],
      ["/macro edit /nope = x", "name", "No macro named /nope"],
      ["/macro rm /go", "name", "built in and can't be deleted"],
      ["/macro rm /brief now", "extra", "takes just the macro's name"],
      ["/macro frob", "action", "Unknown action"],
      ["/macro list all", "extra", "takes nothing else"],
      ["/macro add = x", "equals", "Name the macro before ="],
    ];
    for (const [buffer, role, message] of cases) {
      const result = parse(buffer, [BRIEF]);
      expect({ buffer, role: result.error?.role, message: result.error?.message }).toEqual({ buffer, role, message: expect.stringContaining(message) });
    }
    // A missing text after = is an error once the cursor has moved on.
    const missing = parse("/macro add /x =  ", [], 0);
    expect(missing.error).toMatchObject({ role: "equals", message: expect.stringContaining("Type what /x expands to") });
  });

  test("parts still being typed are incomplete, not errors", () => {
    for (const buffer of ["/macro ad", "/macro add ", "/macro add /", "/macro edit /br", "/macro add /x ="]) {
      const result = parse(buffer, [BRIEF]);
      expect({ buffer, error: result.error, incomplete: typeof result.incomplete }).toEqual({ buffer, error: null, incomplete: "string" });
    }
  });

  test("the line keeps the normal command highlighting; only a wrong part is red", () => {
    const { state } = connectedState([BRIEF]);
    const ranges = (buffer: string) => {
      state.inputBuffer = buffer;
      state.cursorPos = buffer.length;
      return getPromptHighlightRanges(state, buffer).map(range => [buffer.slice(range.start, range.end), range.color ?? "command"]);
    };
    // Like any command: the command and its known arguments, nothing more.
    expect(ranges("/macro add /tldr Answer briefly = Answer in one short sentence.")).toEqual([["/macro add", "command"]]);
    expect(ranges("/macro rm /brief")).toEqual([["/macro rm /brief", "command"]]);
    // A wrong part is red, whether or not it would otherwise highlight.
    expect(ranges("/macro add /go = x")).toEqual([["/macro add", "command"], ["/go", theme.error]]);
    expect(ranges("/macro rm /nope")).toEqual([["/macro rm", "command"], ["/nope", theme.error]]);
    expect(ranges("/macro frob")).toEqual([["/macro", "command"], ["frob", theme.error]]);
  });
});

describe("/macro help while typing", () => {
  test("ghost text names the parts still to type", () => {
    const ctx = contextWith([BRIEF]);
    const ghost = (buffer: string) => macroGhostText(buffer, buffer.length, ctx);
    expect(ghost("/macro ")).toBe("add /name = text");
    expect(ghost("/macro ad")).toBe("d /name = text");
    expect(ghost("/macro add ")).toBe("/name [description] = text");
    expect(ghost("/macro add /tldr")).toBe(" [description] = text");
    expect(ghost("/macro add /tldr Short")).toBe(" = text");
    expect(ghost("/macro add /tldr =")).toBe(" text /tldr expands to");
    expect(ghost("/macro add /tldr = done")).toBe("");
    expect(ghost("/macro edit /br")).toBe("ief = new text");
    expect(ghost("/macro rm ")).toBe("/brief");
    expect(ghost("/macro edit ")).toBe("/brief = new text");
    // Nothing is suggested over a mistake.
    expect(ghost("/macro add /go")).toBe("");
  });

  test("Tab completes subcommands, and your macros for edit and rm with a preview", () => {
    const ctx = contextWith([BRIEF, { name: "/review", expansion: "Review this:\n- bugs\n- tests" }]);
    expect(macroCompletions("/macro ", 7, ctx).map(item => [item.name, item.insertText])).toEqual([
      ["add", "/macro add "], ["edit", "/macro edit "], ["rm", "/macro rm "], ["list", "/macro list "], ["undo", "/macro undo "],
    ]);
    expect(macroCompletions("/macro e", 8, ctx).map(item => item.name)).toEqual(["edit"]);
    expect(macroCompletions("/macro rm ", 10, ctx)).toEqual([
      { name: "/brief", desc: "Answer briefly · Answer in one short sentence.", insertText: "/macro rm /brief " },
      { name: "/review", desc: "Review this: (+2 lines)", insertText: "/macro rm /review " },
    ]);
    expect(macroCompletions("/macro edit /re", 15, ctx).map(item => item.name)).toEqual(["/review"]);
    expect(macroCompletions("/macro add ", 11, ctx)).toEqual([]);
  });

  test("the autocomplete popup uses them, and Tab fills the prompt", () => {
    const { state } = connectedState([BRIEF]);
    state.inputBuffer = "/macro rm ";
    state.cursorPos = state.inputBuffer.length;
    updateAutocomplete(state);
    expect(state.autocomplete?.matches.map(item => item.name)).toEqual(["/brief"]);
  });

  test("with nothing to complete, the popup row is the error, the preview, or the next part", () => {
    const ctx = { ...contextWith([BRIEF]), lastDeleted: null };
    const row = (buffer: string) => macroPopupRow(macroGuide(buffer, buffer.length, ctx)!);
    expect(row("/macro add ")).toEqual({ name: "/name", desc: "the macro's name, e.g. /brief" });
    expect(row("/macro add /tldr ")).toEqual({ name: "[description] = text", desc: "optional description, then what /tldr expands to" });
    expect(row("/macro add /tldr Answer briefly")).toEqual({ name: "= text", desc: "what /tldr expands to" });
    expect(row("/macro add /tldr =")).toEqual({ name: "text", desc: "what /tldr expands to" });
    expect(row("/macro add /tldr = Keep it short.\nNo lists.")).toEqual({ name: "/tldr", desc: "→ Keep it short. (+1 line)" });
    expect(row("/macro edit /brief ")).toEqual({ name: "= new text", desc: "or Enter to open it in the editor" });
    expect(row("/macro rm /brief")).toEqual({ name: "/brief", desc: "→ Answer in one short sentence." });
    expect(row("/macro undo")).toEqual({ name: "", desc: "Nothing deleted to restore." });
    expect(row("/macro add /go = x")).toEqual({ name: "✗", desc: "/go is a built-in macro; pick another name.", descColor: theme.error });
  });

  test("an error in the part being typed waits for a pause", () => {
    const typing = { ...contextWith([BRIEF]), holdTypingErrors: true };
    // At the cursor: held, so "/go" does not flash on the way to "/gold".
    expect(parseMacroCommand("/macro add /go", 14, typing)!.error).toBeNull();
    // A part the cursor has left shows at once, as does everything after a pause.
    expect(parseMacroCommand("/macro add /go = x", 18, typing)!.error?.role).toBe("name");
    expect(parse("/macro add /go").error?.role).toBe("name");
  });

  test("the render uses the normal popup: completions, else the one row, and ghost text after the cursor", () => {
    expect(renderRows("/macro ").above.map(row => row.trim().split(/\s+/)[0])).toEqual(["add", "edit", "rm", "list", "undo"]);
    expect(renderRows("/macro add ").above).toEqual([expect.stringMatching(/\/name +the macro's name, e\.g\. \/brief/)]);
    const described = renderRows("/macro add /tldr Answer briefly");
    expect(described.above).toEqual([expect.stringMatching(/= text +what \/tldr expands to/)]);
    expect(described.prompt).toContain("/macro add /tldr Answer briefly = text");
    expect(renderRows("/macro add /tldr Answer briefly = Hi").above).toEqual([expect.stringMatching(/\/tldr +→ Hi/)]);
    // An error wins over completions.
    expect(renderRows("/macro add /go = x").above).toEqual([expect.stringMatching(/✗ +\/go is a built-in macro; pick another name\./)]);
    expect(renderRows("/macro rm ").above).toEqual([expect.stringContaining("/brief Answer briefly · Answer in one short sentence.")]);
    // The popup row of a normal message is untouched.
    expect(renderRows("hi /bri").above).toEqual([expect.stringContaining("/brief")]);
  });
});

describe("/macro changes", () => {
  test("add works at once, before the daemon answers", () => {
    const { state, sent, daemon } = connectedState();
    enter(state, daemon, "/macro add /brief Answer briefly = Answer in one short sentence.");
    expect(sent).toEqual([{ reqId: "req-1", op: "save", macro: BRIEF, create: true }]);
    expect(state.inputBuffer).toBe("");
    expect(lastNotice(state)).toBe("✓ Saved /brief → Answer in one short sentence.  ·  type /brief anywhere in a message");
    // No answer yet: the macro already expands, completes and highlights.
    expect(expandMacros("ok /brief")).toBe("ok Answer in one short sentence.");
    expect(inlineSlashCompletions(state, "/bri").map(item => item.name)).toEqual(["/brief"]);
    expect(getPromptHighlightRanges(state, "x /brief")).toEqual([{ start: 2, end: 8 }]);

    handleEvent({ type: "user_macros", macros: [BRIEF] }, state, daemon);
    handleEvent({ type: "user_macros", reqId: "req-1", macros: [BRIEF], change: { action: "created", macro: BRIEF } }, state, daemon);
    expect(state.macroStore.pending).toEqual([]);
    expect(getUserMacros()).toEqual([BRIEF]);
  });

  test("a refused change rolls back, says so, and puts the command back", () => {
    const { state, daemon } = connectedState();
    const text = "/macro add /x = the text";
    enter(state, daemon, text);
    expect(isMacroName("/x")).toBe(true);
    handleEvent({ type: "error", reqId: "req-1", message: "Unknown command: save_user_macro" }, state, daemon);
    expect(isMacroName("/x")).toBe(false);
    expect(lastNotice(state)).toBe("✗ /x was not saved: this daemon predates /macro; update it first. Undone; your command is back in the prompt.");
    expect(state.inputBuffer).toBe(text);
  });

  test("a line with a mistake is refused and kept", () => {
    const { state, sent, daemon } = connectedState();
    enter(state, daemon, "/macro add /go = x");
    expect(sent).toEqual([]);
    expect(lastNotice(state)).toContain("/go is a built-in macro");
    expect(state.inputBuffer).toBe("/macro add /go = x");
  });

  test("edit replaces the text and keeps the description unless given", () => {
    const { state, sent, daemon } = connectedState([BRIEF]);
    enter(state, daemon, "/macro edit /brief = Two sentences at most.");
    expect(sent.at(-1)).toMatchObject({ op: "save", create: false, macro: { ...BRIEF, expansion: "Two sentences at most." } });
    expect(lastNotice(state)).toBe("✓ Updated /brief → Two sentences at most.");
    expect(expandMacros("/brief")).toBe("Two sentences at most.");
  });

  test("without = the centred editor opens for multi-line text, and :wq saves it", () => {
    const { state, sent, daemon } = connectedState([BRIEF]);
    enter(state, daemon, "/macro edit /brief");
    const editor = state.instructionsModal?.editor;
    expect(editor?.macro).toEqual({ name: "/brief", description: "Answer briefly", create: false });
    expect(editor?.buffer).toBe(BRIEF.expansion);
    editor!.buffer = "Line one.\nLine two.";
    for (const char of ":wq") handleInstructionsModalKey({ type: "char", char } as never, state, daemon);
    const outcome = handleInstructionsModalKey({ type: "enter" } as never, state, daemon);
    expect(outcome).toEqual({ type: "save_macro", draft: { name: "/brief", description: "Answer briefly", create: false }, text: "Line one.\nLine two." });
    expect(state.instructionsModal).toBeNull();
    if (outcome.type === "save_macro") saveMacroFromEditor(state, daemon, outcome.draft, outcome.text);
    expect(sent.at(-1)).toMatchObject({ op: "save", create: false, macro: { expansion: "Line one.\nLine two." } });

    enter(state, daemon, "/macro add /essay Long one");
    expect(state.instructionsModal?.editor?.macro).toEqual({ name: "/essay", description: "Long one", create: true });
    expect(state.instructionsModal?.editor?.vim.mode).toBe("insert");
  });

  test("rm is instant and undo brings it back", () => {
    const { state, sent, daemon } = connectedState([BRIEF]);
    enter(state, daemon, "/macro rm /brief");
    expect(sent.at(-1)).toEqual({ reqId: "req-1", op: "delete", name: "/brief" });
    expect(isMacroName("/brief")).toBe(false);
    expect(commandCompletions(state, "/brief")).toEqual([]);
    expect(lastNotice(state)).toBe("✓ Deleted /brief. /macro undo brings it back.");

    enter(state, daemon, "/macro undo");
    expect(sent.at(-1)).toEqual({ reqId: "req-2", op: "save", macro: BRIEF, create: true });
    expect(isMacroName("/brief")).toBe(true);
    expect(lastNotice(state)).toBe("✓ Restored /brief → Answer in one short sentence.");
    enter(state, daemon, "/macro undo");
    expect(lastNotice(state)).toBe("✗ No deleted macro to restore.");
  });

  test("list shows yours with their text, then the built-ins by name", () => {
    const state = createInitialState();
    setUserMacros([BRIEF, { name: "/go", expansion: "shadowed" }]);
    expect(tryCommand("/macro", state)).toEqual({ type: "handled" });
    const list = lastNotice(state);
    expect(list).toMatch(/^Your macros \(2\):\n {2}\/brief +Answer briefly · Answer in one short sentence\.\n {2}\/go +shadowed {2}\[inactive: a built-in uses this name\]\nBuilt-in macros \(\d+\):\n {2}\/consider {2}\/commit/);
  });

  test("/ssh to another daemon drops the old daemon's macros and reports unconfirmed changes", () => {
    const { state, daemon } = connectedState([BRIEF]);
    enter(state, daemon, "/macro add /x = y");
    handleEvent({ type: "ssh_status", mode: "remote", state: "connected", alias: "whale", switched: true, message: "Connected" }, state, daemon);
    expect(getUserMacros()).toEqual([]);
    expect(state.messages.map(message => (message as { text?: string }).text)).toContainEqual(expect.stringContaining("✗ /x was not saved: not confirmed before switching daemons"));
  });
});

describe("user macro store over a dropping link", () => {
  test("a change made before the list arrives waits, then is sent", () => {
    const store = createUserMacroStore();
    const { sent, daemon } = fakeDaemon();
    submitUserMacroChange(store, daemon, { change: { kind: "save", macro: BRIEF, create: true }, label: "save" });
    expect(sent).toEqual([]);
    expect(shownUserMacros(store)).toEqual([BRIEF]);
    expect(receiveUserMacros(store, daemon, [])).toEqual([]);
    expect(sent).toEqual([{ reqId: "req-1", op: "save", macro: BRIEF, create: true }]);
  });

  test("after reconnecting, a change that landed is not sent again; one that did not is", () => {
    const store = createUserMacroStore();
    const { sent, daemon } = fakeDaemon();
    receiveUserMacros(store, daemon, []);
    submitUserMacroChange(store, daemon, { change: { kind: "save", macro: BRIEF, create: true }, label: "save" });
    expect(sent).toHaveLength(1);
    storeConnectionLost(store);
    // Offline: the delete waits for the list sent after reconnecting.
    submitUserMacroChange(store, daemon, { change: { kind: "delete", name: "/old" }, label: "delete" });
    expect(sent).toHaveLength(1);
    // The save got there; /old still exists.
    receiveUserMacros(store, daemon, [BRIEF, { name: "/old", expansion: "o" }]);
    expect(sent.slice(1)).toEqual([{ reqId: "req-2", op: "delete", name: "/old" }]);
    expect(shownUserMacros(store)).toEqual([BRIEF]);
  });

  test("a new macro added elsewhere meanwhile fails instead of being overwritten", () => {
    const { state, daemon } = connectedState();
    enter(state, daemon, "/macro add /brief = mine");
    userMacrosConnectionLost(state);
    handleEvent({ type: "user_macros", macros: [BRIEF] }, state, daemon);
    expect(lastNotice(state)).toContain("✗ /brief was not saved: /brief was added elsewhere meanwhile");
    expect(expandMacros("/brief")).toBe(BRIEF.expansion);
  });
});

test("expansion previews are one line", () => {
  expect(expansionPreview("a\nb\nc")).toBe("a (+2 lines)");
  expect(expansionPreview("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
});
