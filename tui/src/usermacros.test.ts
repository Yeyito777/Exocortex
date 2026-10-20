import { afterEach, describe, expect, test } from "bun:test";
import type { UserMacro } from "@exocortex/shared/user-macros";
import { MACRO_COMMAND, getCommandArgs, tryCommand } from "./commands";
import { handleEvent, type DaemonActions } from "./events";
import { expandMacros, getUserMacros, isMacroName, setUserMacros } from "./macros";
import { getPromptHighlightRanges } from "./prompthighlight";
import { commandCompletions, inlineSlashCompletions, resolveSlashShorthands } from "./slashsearch";
import { createInitialState, type RenderState } from "./state";
import { macroDraftLabel, runUserMacroCommand, submitMacroDraft, type UserMacroActions } from "./usermacros";

afterEach(() => setUserMacros([]));

const STANDUP: UserMacro = { name: "/standup", expansion: "Summarize what we did today.", description: "Daily standup" };

const daemonActions: DaemonActions = {
  subscribe() {}, unsubscribe() {}, sendMessage() {}, setSystemInstructions() {}, loadToolOutputs() {},
};

function fakeDaemon() {
  const calls: Array<{ op: "save"; macro: UserMacro; create: boolean } | { op: "delete"; name: string }> = [];
  let next = 0;
  const daemon: UserMacroActions = {
    saveUserMacro(macro, create) { calls.push({ op: "save", macro, create }); return `req-${++next}`; },
    deleteUserMacro(name) { calls.push({ op: "delete", name }); return `req-${++next}`; },
  };
  return { calls, daemon };
}

/** Run a /macro prompt the way main.ts does. */
function runMacro(state: RenderState, daemon: UserMacroActions, text: string): void {
  state.inputBuffer = text;
  runUserMacroCommand(state, daemon, MACRO_COMMAND.handler(text, state));
}

function lastNotice(state: RenderState): string {
  return (state.messages.at(-1) as { text?: string } | undefined)?.text ?? "";
}

function receive(state: RenderState, event: Parameters<typeof handleEvent>[0]): void {
  handleEvent(event, state, daemonActions);
}

describe("user macros in autocomplete, highlighting and expansion", () => {
  test("a macro from the daemon works at once and is gone once deleted", () => {
    const state = createInitialState();
    expect(expandMacros("/standup please")).toBe("/standup please");
    expect(commandCompletions(state, "/stand")).toEqual([]);

    receive(state, { type: "user_macros", macros: [STANDUP] });
    expect(getUserMacros()).toEqual([STANDUP]);
    expect(commandCompletions(state, "/stand")).toEqual([
      expect.objectContaining({ name: "/standup", desc: "Daily standup" }),
    ]);
    expect(inlineSlashCompletions(state, "/standu").map(item => item.name)).toEqual(["/standup"]);
    expect(getPromptHighlightRanges(state, "first /standup then")).toEqual([{ start: 6, end: 14 }]);
    expect(expandMacros("ok /standup and /go")).toBe("ok Summarize what we did today. and Go ahead and implement that");
    // A one-line prompt sends the popup's first option, as for built-ins.
    expect(resolveSlashShorthands(state, "/standu")).toBe("/standup");

    receive(state, { type: "user_macros", macros: [] });
    expect(isMacroName("/standup")).toBe(false);
    expect(commandCompletions(state, "/stand")).toEqual([]);
    expect(getPromptHighlightRanges(state, "first /standup then")).toEqual([]);
    expect(expandMacros("/standup")).toBe("/standup");
  });

  test("multi-line text expands verbatim and keeps trailing words", () => {
    setUserMacros([{ name: "/review", expansion: "Review this:\n- bugs\n- tests\nCost: $1 & $&" }]);
    expect(expandMacros("/review now")).toBe("Review this:\n- bugs\n- tests\nCost: $1 & $& now");
  });

  test("without a description, autocomplete previews the text", () => {
    const state = createInitialState();
    setUserMacros([{ name: "/preview", expansion: "First line of a fairly long macro that keeps going\nsecond" }]);
    expect(commandCompletions(state, "/preview")[0]!.desc).toBe("First line of a fairly long macro that keeps go…");
  });

  test("a built-in macro wins a name clash", () => {
    setUserMacros([{ name: "/go", expansion: "mine" }]);
    expect(expandMacros("/go")).toBe("Go ahead and implement that");
    expect(commandCompletions(createInitialState(), "/go").filter(item => item.name === "/go")).toHaveLength(1);
  });

  test("/ssh to another daemon drops the old daemon's macros", () => {
    const state = createInitialState();
    receive(state, { type: "user_macros", macros: [STANDUP] });
    receive(state, { type: "ssh_status", mode: "remote", state: "connected", alias: "whale", switched: true, message: "Connected" });
    expect(getUserMacros()).toEqual([]);
  });
});

describe("/macro", () => {
  test("add puts the prompt in draft mode; Enter saves the typed text", () => {
    const state = createInitialState();
    const { calls, daemon } = fakeDaemon();
    runMacro(state, daemon, "/macro add /standup Daily standup");
    expect(state.macroDraft).toEqual({ name: "/standup", description: "Daily standup", create: true });
    expect(state.inputBuffer).toBe("");
    expect(macroDraftLabel(state.macroDraft!)).toContain("New macro /standup (Daily standup)");
    expect(calls).toEqual([]);

    state.inputBuffer = "  Summarize what we did today.\n";
    submitMacroDraft(state, daemon, false);
    expect(calls).toEqual([{ op: "save", macro: STANDUP, create: true }]);
    expect(state.macroDraft).toBeNull();
    expect(state.inputBuffer).toBe("");

    receive(state, { type: "user_macros", reqId: "req-1", macros: [STANDUP], change: { action: "created", macro: STANDUP } });
    expect(lastNotice(state)).toBe("✓ Saved macro /standup. Type /standup anywhere in a message to use it.");
    expect(state.pendingMacroRequests.size).toBe(0);
    expect(expandMacros("/standup")).toBe(STANDUP.expansion);
  });

  test("Enter on an empty draft cancels without saving", () => {
    const state = createInitialState();
    const { calls, daemon } = fakeDaemon();
    runMacro(state, daemon, "/macro add /x");
    state.inputBuffer = "   ";
    submitMacroDraft(state, daemon, false);
    expect(calls).toEqual([]);
    expect(state.macroDraft).toBeNull();
    expect(lastNotice(state)).toBe("Cancelled new macro /x.");
  });

  test("lines after the /macro add line save at once", () => {
    const state = createInitialState();
    const { calls, daemon } = fakeDaemon();
    runMacro(state, daemon, "/macro add /review\nReview this:\n- bugs\n- tests");
    expect(state.macroDraft).toBeNull();
    expect(calls).toEqual([{ op: "save", create: true, macro: { name: "/review", expansion: "Review this:\n- bugs\n- tests" } }]);
  });

  test("names must be valid and unused by built-ins or existing macros", () => {
    const state = createInitialState();
    const { calls, daemon } = fakeDaemon();
    setUserMacros([STANDUP]);
    for (const [text, error] of [
      ["/macro add", "Give the macro a name"],
      ["/macro add standup", "start with \"/\""],
      ["/macro add /a.b", "letters, digits"],
      ["/macro add /go", "/go is a built-in macro"],
      ["/macro add /model", "/model is a built-in command"],
      ["/macro add /effort", "/effort is a built-in command"],
      ["/macro add /macro", "/macro is a built-in command"],
      ["/macro add /standup", "already exists. Use /macro edit /standup"],
    ] as const) {
      runMacro(state, daemon, text);
      expect(lastNotice(state)).toContain(error);
      expect(state.macroDraft).toBeNull();
      // The prompt is kept so the name can be fixed.
      expect(state.inputBuffer).toBe(text);
    }
    expect(calls).toEqual([]);
  });

  test("edit prefills the current text and keeps the description unless given", () => {
    const state = createInitialState();
    const { calls, daemon } = fakeDaemon();
    setUserMacros([STANDUP]);
    runMacro(state, daemon, "/macro edit /standup");
    expect(state.macroDraft).toEqual({ name: "/standup", description: "Daily standup", create: false });
    expect(state.inputBuffer).toBe(STANDUP.expansion);
    expect(state.cursorPos).toBe(STANDUP.expansion.length);
    state.inputBuffer = "Summarize this week.";
    submitMacroDraft(state, daemon, false);
    expect(calls.at(-1)).toEqual({ op: "save", create: false, macro: { ...STANDUP, expansion: "Summarize this week." } });

    runMacro(state, daemon, "/macro edit /go");
    expect(lastNotice(state)).toContain("built in and can't be edited");
  });

  test("rm deletes, the confirmation offers undo, and undo restores it", () => {
    const state = createInitialState();
    const { calls, daemon } = fakeDaemon();
    receive(state, { type: "user_macros", macros: [STANDUP] });
    expect(getCommandArgs(state, "/macro")["/macro rm"]).toEqual([{ name: "/standup", desc: "Daily standup" }]);

    runMacro(state, daemon, "/macro rm /standup");
    expect(calls).toEqual([{ op: "delete", name: "/standup" }]);
    receive(state, { type: "user_macros", reqId: "req-1", macros: [], change: { action: "deleted", macro: STANDUP } });
    expect(lastNotice(state)).toBe("✓ Deleted macro /standup. /macro undo brings it back.");
    expect(commandCompletions(state, "/standup")).toEqual([]);
    expect(expandMacros("/standup")).toBe("/standup");

    runMacro(state, daemon, "/macro undo");
    expect(calls.at(-1)).toEqual({ op: "save", macro: STANDUP, create: true });
    receive(state, { type: "user_macros", reqId: "req-2", macros: [STANDUP], change: { action: "created", macro: STANDUP } });
    expect(lastNotice(state)).toBe("✓ Restored macro /standup.");
    expect(state.lastDeletedMacro).toBeNull();
    runMacro(state, daemon, "/macro undo");
    expect(lastNotice(state)).toContain("No deleted macro to restore");

    runMacro(state, daemon, "/macro rm /nope");
    expect(lastNotice(state)).toContain("No macro named /nope");
  });

  test("a rejected save reports the error and gives the text back as a draft", () => {
    const state = createInitialState();
    const { daemon } = fakeDaemon();
    runMacro(state, daemon, "/macro add /x");
    state.inputBuffer = "the text";
    submitMacroDraft(state, daemon, false);
    receive(state, { type: "error", reqId: "req-1", message: "Unknown command: save_user_macro" });
    expect(lastNotice(state)).toBe("✗ Could not save macro /x: this daemon predates /macro; update it first.");
    expect(state.macroDraft).toEqual({ name: "/x", create: true });
    expect(state.inputBuffer).toBe("the text");
  });

  test("list shows your macros, then the built-ins", () => {
    const state = createInitialState();
    setUserMacros([{ name: "/go", expansion: "shadowed" }, STANDUP]);
    const result = tryCommand("/macro", state);
    expect(result).toEqual({ type: "handled" });
    const list = lastNotice(state);
    expect(list).toMatch(/^Your macros \(2\):\n {2}\/go +shadowed {2}\[inactive: a built-in uses this name\]\n {2}\/standup +Daily standup\n\nBuilt-in macros \(\d+\):/);
    expect(list).toContain("/consider");
    expect(tryCommand("/macro list", state)).toEqual({ type: "handled" });
  });

  test("autocomplete offers the subcommands and your macros", () => {
    const state = createInitialState();
    setUserMacros([STANDUP]);
    expect(commandCompletions(state, "/macro ").map(item => item.name)).toEqual(["list", "add", "edit", "rm", "undo"]);
    expect(commandCompletions(state, "/macro edit ").map(item => item.name)).toEqual(["/standup"]);
    expect(getPromptHighlightRanges(state, "/macro rm /standup")).toContainEqual({ start: 0, end: 18 });
  });
});
