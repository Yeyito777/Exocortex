import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "../input";
import { createInitialState, type RenderState } from "../state";
import { stripAnsi } from "../historycursor";
import { termWidth } from "../textwidth";
import {
  handleInstructionsEvent,
  handleInstructionsModalKey,
  instructionsConnectionLost,
  instructionsReconnected,
  instructionsRouteSwitched,
  openFolderInstructionsEditor,
  openInstructionsPicker,
  prefetchCurrentInstructions,
  type InstructionsDaemon,
  type InstructionsKeyOutcome,
} from "./controller";
import { renderInstructionsEditor, renderInstructionsPicker } from "./render";
import { createInstructionsEditor, summarizeInstructions } from "./state";

class FakeDaemon implements InstructionsDaemon {
  connected = true;
  calls: Array<{ method: string; args: unknown[]; reqId: string }> = [];
  private next = 0;
  private record(method: string, args: unknown[]): string {
    const reqId = `${method}-${++this.next}`;
    this.calls.push({ method, args, reqId });
    return reqId;
  }
  loadInstructions(convId: string | null, folderId: string | null) { return this.record("loadInstructions", [convId, folderId]); }
  setSystemInstructions(convId: string, text: string) { return this.record("setSystemInstructions", [convId, text]); }
  setFolderInstructions(folderId: string, text: string) { return this.record("setFolderInstructions", [folderId, text]); }
  setGlobalInstructions(text: string, expectedText?: string) { return this.record("setGlobalInstructions", [text, expectedText]); }
  last(method?: string) {
    const calls = method ? this.calls.filter(call => call.method === method) : this.calls;
    return calls.at(-1)!;
  }
}

function conversationState(folder = true): RenderState {
  const state = createInitialState();
  state.convId = "conv-1";
  state.sidebar.conversations = [{
    id: "conv-1", provider: state.provider, model: state.model, effort: state.effort, fastMode: state.fastMode,
    createdAt: 1, updatedAt: 2, messageCount: 2, title: "Trip planning", marked: false, pinned: false,
    streaming: false, unread: false, sortOrder: 0, folderId: folder ? "folder-1" : null,
  }];
  state.sidebar.folders = folder
    ? [{ id: "folder-1", name: "Travel", parentId: null, createdAt: 1, updatedAt: 1, pinned: false, sortOrder: 0 }]
    : [];
  return state;
}

function keys(text: string): KeyEvent[] {
  return [...text].map(char => ({ type: "char", char }));
}

const ESC: KeyEvent = { type: "escape" };
const ENTER: KeyEvent = { type: "enter" };

function press(state: RenderState, daemon: FakeDaemon, ...input: Array<string | KeyEvent>): InstructionsKeyOutcome {
  let outcome: InstructionsKeyOutcome = { type: "handled" };
  for (const item of input) {
    for (const key of typeof item === "string" ? keys(item) : [item]) outcome = handleInstructionsModalKey(key, state, daemon);
  }
  return outcome;
}

/** Open the picker and answer its load. */
function openLoaded(state: RenderState, daemon: FakeDaemon, texts = { conversation: "", folder: "", global: "" }): void {
  openInstructionsPicker(state, daemon);
  answerLoad(state, daemon, texts);
}

function answerLoad(state: RenderState, daemon: FakeDaemon, texts: { conversation: string; folder: string | null; global: string }): void {
  const call = daemon.last("loadInstructions");
  handleInstructionsEvent(state, {
    type: "instructions_loaded", reqId: call.reqId,
    convId: call.args[0] as string | null, folderId: call.args[1] as string | null,
    conversation: texts.conversation, folder: texts.folder, global: texts.global,
  }, daemon);
}

function plain(payload: string): string {
  return stripAnsi(payload.replace(/\x1b\[\d+;\d+H/g, "\n"));
}

describe("/instructions picker", () => {
  test("loads all three scopes for the conversation and its folder", () => {
    const state = conversationState();
    const daemon = new FakeDaemon();
    openInstructionsPicker(state, daemon);

    expect(daemon.last().method).toBe("loadInstructions");
    expect(daemon.last().args).toEqual(["conv-1", "folder-1"]);
    expect(state.instructionsModal?.picker?.target).toEqual({ convId: "conv-1", convTitle: "Trip planning", folderId: "folder-1", folderName: "Travel" });
    expect(plain(renderInstructionsPicker(state.instructionsModal!.picker!, 40, 120).payload)).toContain("loading…");

    answerLoad(state, daemon, { conversation: "Be brief.\nUse metric units.", folder: "", global: "You are Exo." });
    const shown = plain(renderInstructionsPicker(state.instructionsModal!.picker!, 40, 120).payload);
    expect(shown).toContain("Instructions");
    expect(shown).toContain("Conversation");
    expect(shown).toContain("Trip planning");
    expect(shown).toContain("“Be brief.”");
    expect(shown).toContain("2 lines · 27 chars");
    expect(shown).toContain("Folder");
    expect(shown).toContain("every conversation in Travel/");
    expect(shown).toContain("empty");
    expect(shown).toContain("Global");
    expect(shown).toContain("“You are Exo.”");
    expect(shown).toContain("j/k move · Enter edit · Esc close");
  });

  test("shortens a long first line instead of dropping its size", () => {
    const state = conversationState();
    const daemon = new FakeDaemon();
    openLoaded(state, daemon, { conversation: `${"walk ".repeat(30)}\nsecond`, folder: "", global: "" });
    const shown = plain(renderInstructionsPicker(state.instructionsModal!.picker!, 40, 90).payload);
    expect(shown).toContain("walk w…”");
    expect(shown).toContain("2 lines · 157 chars");
  });

  test("says when the conversation has no folder and skips that row", () => {
    const state = conversationState(false);
    const daemon = new FakeDaemon();
    openLoaded(state, daemon, { conversation: "", folder: null, global: "" } as never);

    expect(daemon.calls[0].args).toEqual(["conv-1", null]);
    expect(plain(renderInstructionsPicker(state.instructionsModal!.picker!, 40, 120).payload)).toContain("No folder: this conversation is at the top level");
    press(state, daemon, "j");
    expect(state.instructionsModal!.picker!.selection).toBe(2);
    press(state, daemon, "k");
    expect(state.instructionsModal!.picker!.selection).toBe(0);
    press(state, daemon, "2");
    expect(state.instructionsModal!.editor).toBeNull();
  });

  test("j/k and arrows move, Enter opens the editor, Esc closes", () => {
    const state = conversationState();
    const daemon = new FakeDaemon();
    openLoaded(state, daemon, { conversation: "", folder: "Pack light.", global: "" });

    press(state, daemon, { type: "down" });
    expect(state.instructionsModal!.picker!.selection).toBe(1);
    press(state, daemon, ENTER);
    const editor = state.instructionsModal!.editor!;
    expect(editor.scope).toBe("folder");
    expect(editor.buffer).toBe("Pack light.");
    expect(editor.vim.mode).toBe("normal");

    press(state, daemon, ESC);
    expect(state.instructionsModal?.editor).toBeNull();
    expect(state.instructionsModal?.picker).not.toBeNull();
    press(state, daemon, ESC);
    expect(state.instructionsModal).toBeNull();
  });

  test("does not open an editor before the text has loaded", () => {
    const state = conversationState();
    const daemon = new FakeDaemon();
    openInstructionsPicker(state, daemon);
    press(state, daemon, ENTER);
    expect(state.instructionsModal!.editor).toBeNull();
  });

  test("in a draft, the conversation row is the new conversation", () => {
    const state = createInitialState();
    state.pendingSystemInstructions = null;
    const daemon = new FakeDaemon();
    openLoaded(state, daemon);
    expect(daemon.calls[0].args).toEqual([null, null]);
    expect(plain(renderInstructionsPicker(state.instructionsModal!.picker!, 40, 120).payload)).toContain("the new conversation");
  });
});

describe("instructions editor", () => {
  test("uses the prompt's Vim keys: insert, normal motions, operators and undo", () => {
    const state = conversationState();
    const daemon = new FakeDaemon();
    openLoaded(state, daemon);
    press(state, daemon, ENTER);
    const editor = () => state.instructionsModal!.editor!;
    expect(editor().vim.mode).toBe("insert");

    press(state, daemon, "first line", ENTER, "second line", ESC);
    expect(editor().buffer).toBe("first line\nsecond line");
    expect(editor().vim.mode).toBe("normal");

    press(state, daemon, "gg", "dw");
    expect(editor().buffer).toBe("line\nsecond line");
    press(state, daemon, "j", "dd");
    expect(editor().buffer).toBe("line");
    press(state, daemon, "u");
    expect(editor().buffer).toBe("line\nsecond line");
    press(state, daemon, "u");
    expect(editor().buffer).toBe("first line\nsecond line");
    press(state, daemon, { type: "ctrl-r" });
    expect(editor().buffer).toBe("line\nsecond line");

    press(state, daemon, "gg", "V", "j", "d");
    expect(editor().buffer).toBe("");
    press(state, daemon, "o", "x", ESC, "ciw", "word", ESC);
    expect(editor().buffer).toBe("\nword");
  });

  test(":w saves the trimmed text through set_system_instructions at once and stays open", () => {
    const state = conversationState();
    const daemon = new FakeDaemon();
    openLoaded(state, daemon, { conversation: "Old.", folder: "", global: "" });
    press(state, daemon, ENTER, "cc", "New rule.  ", ESC);
    const editor = state.instructionsModal!.editor!;
    expect(plain(renderInstructionsEditor(editor, 40, 120).payload)).toContain("● modified");

    press(state, daemon, ":w", ENTER);
    const save = daemon.last();
    expect(save.method).toBe("setSystemInstructions");
    expect(save.args).toEqual(["conv-1", "New rule."]);
    // Optimistic: clean and shown before the daemon answers.
    expect(editor.notice).toEqual({ text: "Saved", tone: "success" });
    expect(plain(renderInstructionsEditor(editor, 40, 120).payload)).not.toContain("● modified");
    expect(state.instructionsModal!.picker!.texts.conversation).toBe("New rule.");

    handleInstructionsEvent(state, { type: "ack", reqId: save.reqId }, daemon);
    expect(state.instructionsModal!.editor).toBe(editor);
    expect(editor.notice).toEqual({ text: "Saved", tone: "success" });
    expect(state.instructionsModal!.picker!.texts.conversation).toBe("New rule.");
  });

  test(":wq and :x close at once; folder and global use their own commands", () => {
    const state = conversationState();
    const daemon = new FakeDaemon();
    openLoaded(state, daemon, { conversation: "", folder: "", global: "Be kind." });

    press(state, daemon, "j", ENTER, "Pack light.", ESC, ":wq", ENTER);
    const folderSave = daemon.last();
    expect(folderSave).toMatchObject({ method: "setFolderInstructions", args: ["folder-1", "Pack light."] });
    expect(state.instructionsModal!.editor).toBeNull();
    expect(state.instructionsModal!.picker!.texts.folder).toBe("Pack light.");
    handleInstructionsEvent(state, { type: "folder_instructions_updated", reqId: folderSave.reqId, folderId: "folder-1", text: "Pack light." }, daemon);
    expect(state.instructionsModal!.picker!.texts.folder).toBe("Pack light.");

    press(state, daemon, "j", ENTER, "A", " Always.", ESC, ":x", ENTER);
    const globalSave = daemon.last();
    // The text it was loaded as guards against overwriting an edit made elsewhere.
    expect(globalSave).toMatchObject({ method: "setGlobalInstructions", args: ["Be kind. Always.", "Be kind."] });
    expect(state.instructionsModal!.editor).toBeNull();
    expect(state.instructionsModal!.picker!.texts.global).toBe("Be kind. Always.");
    handleInstructionsEvent(state, { type: "global_instructions_updated", reqId: globalSave.reqId, text: "Be kind. Always." }, daemon);
    expect(state.instructionsModal!.picker!.texts.global).toBe("Be kind. Always.");
  });

  test("a rejected save rolls the preview back and Enter brings the text back with why", () => {
    const state = conversationState();
    const daemon = new FakeDaemon();
    openLoaded(state, daemon, { conversation: "Before.", folder: "", global: "" });
    press(state, daemon, ENTER, "cc", "Rule.", ESC, ":wq", ENTER);
    const save = daemon.last();
    expect(state.instructionsModal!.picker!.texts.conversation).toBe("Rule.");

    const consumed = handleInstructionsEvent(state, { type: "error", reqId: save.reqId, convId: "conv-1", message: "Cannot rewrite conversation history while it is streaming." }, daemon);

    expect(consumed).toBe(true);
    const picker = state.instructionsModal!.picker!;
    expect(picker.texts.conversation).toBe("Before.");
    const shown = plain(renderInstructionsPicker(picker, 40, 120).payload);
    expect(shown).toContain("✗ Not saved: Cannot rewrite");
    expect(shown).toContain("Enter recovers");
    expect(state.messages).toEqual([]);

    press(state, daemon, ENTER);
    const editor = state.instructionsModal!.editor!;
    expect(editor.buffer).toBe("Rule.");
    expect(editor.savedText).toBe("Before.");
    expect(editor.notice).toEqual({ text: "Not saved: Cannot rewrite conversation history while it is streaming; :w tries again", tone: "error" });
    expect(plain(renderInstructionsEditor(editor, 40, 120).payload)).toContain("● modified");
    expect(state.instructionsModal!.picker!.failures.conversation).toBeNull();
  });

  test("global conflicts suggest :w!, which saves without the guard", () => {
    const state = conversationState();
    const daemon = new FakeDaemon();
    openLoaded(state, daemon, { conversation: "", folder: "", global: "Old." });
    press(state, daemon, "3", "A", " New.", ESC, ":w", ENTER);
    handleInstructionsEvent(state, { type: "error", reqId: daemon.last().reqId, message: "Could not save global instructions: App instructions changed since they were read" }, daemon);
    expect(state.instructionsModal!.editor!.notice?.text).toContain(":w! overwrites");

    press(state, daemon, ":w!", ENTER);
    expect(daemon.last()).toMatchObject({ method: "setGlobalInstructions", args: ["Old. New.", undefined] });
  });

  test(":q refuses unsaved changes, :q! and a second Esc discard them", () => {
    const state = conversationState();
    const daemon = new FakeDaemon();
    openLoaded(state, daemon, { conversation: "Keep.", folder: "", global: "" });
    press(state, daemon, ENTER, "x");
    const editor = state.instructionsModal!.editor!;
    expect(editor.buffer).toBe("eep.");

    press(state, daemon, ":q", ENTER);
    expect(state.instructionsModal!.editor).toBe(editor);
    expect(editor.notice?.tone).toBe("warning");
    press(state, daemon, ":q!", ENTER);
    expect(state.instructionsModal!.editor).toBeNull();

    press(state, daemon, ENTER, "x", ESC);
    expect(state.instructionsModal!.editor).not.toBeNull();
    expect(state.instructionsModal!.editor!.notice?.text).toContain("Esc again discards");
    press(state, daemon, ESC);
    expect(state.instructionsModal!.editor).toBeNull();
    expect(daemon.calls.filter(call => call.method.startsWith("set"))).toEqual([]);
  });

  test("Esc first cancels a half-typed command or the command line, not the editor", () => {
    const state = conversationState();
    const daemon = new FakeDaemon();
    openLoaded(state, daemon, { conversation: "Text.", folder: "", global: "" });
    press(state, daemon, ENTER, "d", ESC);
    expect(state.instructionsModal!.editor).not.toBeNull();
    press(state, daemon, ":wq", ESC);
    expect(state.instructionsModal!.editor!.command).toBeNull();
    expect(daemon.calls.filter(call => call.method.startsWith("set"))).toEqual([]);
    press(state, daemon, ":nope", ENTER);
    expect(state.instructionsModal!.editor!.notice?.tone).toBe("error");
  });

  test("saving empty clears the scope", () => {
    const state = conversationState();
    const daemon = new FakeDaemon();
    openLoaded(state, daemon, { conversation: "Remove me.", folder: "", global: "" });
    press(state, daemon, ENTER, "dd", ":w", ENTER);
    expect(daemon.last()).toMatchObject({ method: "setSystemInstructions", args: ["conv-1", ""] });
    handleInstructionsEvent(state, { type: "ack", reqId: daemon.last().reqId }, daemon);
    expect(state.instructionsModal!.editor!.notice?.text).toBe("Conversation instructions cleared");
  });

  test("in a draft, saving conversation instructions creates the conversation", () => {
    const state = createInitialState();
    const daemon = new FakeDaemon();
    openLoaded(state, daemon);
    const outcome = press(state, daemon, ENTER, "Start with these.", ESC, ":wq", ENTER);
    expect(outcome).toEqual({ type: "create_conversation", text: "Start with these." });
    expect(state.instructionsModal).toBeNull();
  });

  test("the sidebar's AGENTS.md opens that folder's editor directly", () => {
    const state = conversationState();
    const daemon = new FakeDaemon();
    openFolderInstructionsEditor(state, daemon, "folder-1");
    expect(daemon.last().args).toEqual([null, "folder-1"]);
    expect(plain(renderInstructionsEditor(state.instructionsModal!.editor!, 40, 120).payload)).toContain("Loading…");

    answerLoad(state, daemon, { conversation: "", folder: "Pack light.", global: "" });
    const editor = state.instructionsModal!.editor!;
    expect(editor.buffer).toBe("Pack light.");
    expect(state.instructionsModal!.picker).toBeNull();
    press(state, daemon, ESC);
    expect(state.instructionsModal).toBeNull();
  });

  test("an edit made elsewhere refreshes a clean editor but never overwrites unsaved edits", () => {
    const state = conversationState();
    const daemon = new FakeDaemon();
    openLoaded(state, daemon, { conversation: "", folder: "", global: "Old." });
    press(state, daemon, "3");
    handleInstructionsEvent(state, { type: "global_instructions_updated", text: "From another TUI." }, daemon);
    expect(state.instructionsModal!.editor!.buffer).toBe("From another TUI.");

    press(state, daemon, "x");
    handleInstructionsEvent(state, { type: "global_instructions_updated", text: "Third." }, daemon);
    expect(state.instructionsModal!.editor!.buffer).toBe("rom another TUI.");
    expect(state.instructionsModal!.editor!.notice?.text).toContain("Changed elsewhere");
  });
});

describe("/instructions over a slow or dropped link", () => {
  const sets = (daemon: FakeDaemon) => daemon.calls.filter(call => call.method.startsWith("set"));
  const ack = (state: RenderState, daemon: FakeDaemon, reqId: string) => handleInstructionsEvent(state, { type: "ack", reqId, convId: "conv-1" }, daemon);

  test("reopening shows the texts at once and checks them in the background", () => {
    const state = conversationState();
    const daemon = new FakeDaemon();
    openLoaded(state, daemon, { conversation: "Be brief.", folder: "Pack light.", global: "You are Exo." });
    press(state, daemon, ESC);

    openInstructionsPicker(state, daemon);
    const picker = state.instructionsModal!.picker!;
    expect(picker.texts).toEqual({ conversation: "Be brief.", folder: "Pack light.", global: "You are Exo." });
    expect(plain(renderInstructionsPicker(picker, 40, 120).payload)).not.toContain("loading…");
    expect(daemon.last()).toMatchObject({ method: "loadInstructions", args: ["conv-1", "folder-1"] });

    // Scopes open without waiting.
    press(state, daemon, "2");
    expect(state.instructionsModal!.editor!.buffer).toBe("Pack light.");
    press(state, daemon, ESC, "3");
    expect(state.instructionsModal!.editor!.buffer).toBe("You are Exo.");

    // The check brings an edit made elsewhere into the clean editor and the picker.
    answerLoad(state, daemon, { conversation: "Be brief.", folder: "Pack light.", global: "Edited on the laptop." });
    expect(state.instructionsModal!.editor!.buffer).toBe("Edited on the laptop.");
    press(state, daemon, ESC);
    expect(state.instructionsModal!.picker!.texts.global).toBe("Edited on the laptop.");
  });

  test("prefetching fills what is missing once, so the first open is instant too", () => {
    const state = conversationState();
    const daemon = new FakeDaemon();
    prefetchCurrentInstructions(state, daemon);
    expect(daemon.calls.map(call => call.args)).toEqual([["conv-1", "folder-1"]]);
    prefetchCurrentInstructions(state, daemon);
    expect(daemon.calls).toHaveLength(1);
    answerLoad(state, daemon, { conversation: "Be brief.", folder: "", global: "You are Exo." });
    prefetchCurrentInstructions(state, daemon);
    expect(daemon.calls).toHaveLength(1);

    openInstructionsPicker(state, daemon);
    expect(state.instructionsModal!.picker!.texts).toEqual({ conversation: "Be brief.", folder: "", global: "You are Exo." });

    daemon.connected = false;
    state.convId = null;
    state.draftFolderId = "folder-2";
    prefetchCurrentInstructions(state, daemon);
    expect(daemon.calls).toHaveLength(2);
  });

  test("successive saves apply in order and a late confirmation never shows older text", () => {
    const state = conversationState();
    const daemon = new FakeDaemon();
    openLoaded(state, daemon, { conversation: "", folder: "", global: "" });
    press(state, daemon, ENTER, "First.", ESC, ":w", ENTER, "cc", "Second.", ESC, ":wq", ENTER);
    const [first, second] = sets(daemon);
    expect(first.args).toEqual(["conv-1", "First."]);
    expect(second.args).toEqual(["conv-1", "Second."]);
    const picker = state.instructionsModal!.picker!;
    expect(picker.texts.conversation).toBe("Second.");

    // The older save's confirmation and broadcast land first.
    ack(state, daemon, first.reqId);
    handleInstructionsEvent(state, { type: "system_instructions_updated", convId: "conv-1", text: "First." }, daemon);
    expect(picker.texts.conversation).toBe("Second.");

    ack(state, daemon, second.reqId);
    handleInstructionsEvent(state, { type: "system_instructions_updated", convId: "conv-1", text: "Second." }, daemon);
    expect(picker.texts.conversation).toBe("Second.");
    expect(picker.failures.conversation).toBeNull();
  });

  test("an older save failing while a newer one is on its way stays quiet", () => {
    const state = conversationState();
    const daemon = new FakeDaemon();
    openLoaded(state, daemon, { conversation: "", folder: "", global: "Zero." });
    press(state, daemon, "3", "cc", "One.", ESC, ":w", ENTER, "cc", "Two.", ESC, ":w", ENTER);
    const [one, two] = sets(daemon);
    // Each Global save is guarded by the one before it.
    expect(one.args).toEqual(["One.", "Zero."]);
    expect(two.args).toEqual(["Two.", "One."]);

    handleInstructionsEvent(state, { type: "error", reqId: one.reqId, message: "Could not save global instructions: disk full" }, daemon);
    const editor = state.instructionsModal!.editor!;
    expect(editor.notice).toEqual({ text: "Saved", tone: "success" });
    handleInstructionsEvent(state, { type: "global_instructions_updated", reqId: two.reqId, text: "Two." }, daemon);
    expect(state.instructionsModal!.picker!.texts.global).toBe("Two.");
    expect(editor.buffer).toBe("Two.");
  });

  test("a failure after the modal closed is announced in the chat and recoverable", () => {
    const state = conversationState();
    const daemon = new FakeDaemon();
    openLoaded(state, daemon, { conversation: "", folder: "Old.", global: "" });
    press(state, daemon, "2", "cc", "New.", ESC, ":wq", ENTER, ESC);
    expect(state.instructionsModal).toBeNull();

    handleInstructionsEvent(state, { type: "error", reqId: sets(daemon)[0].reqId, message: "Folder folder-1 not found" }, daemon);
    const notice = state.messages.at(-1);
    expect(notice?.role).toBe("system");
    expect(notice && "text" in notice ? notice.text : "").toBe("✗ Folder instructions for Travel/ were not saved: Folder folder-1 not found. Open /instructions to get the text back.");

    openInstructionsPicker(state, daemon);
    expect(state.instructionsModal!.picker!.texts.folder).toBe("Old.");
    expect(state.instructionsModal!.picker!.failures.folder).toBe("Folder folder-1 not found");
    press(state, daemon, "2");
    expect(state.instructionsModal!.editor!.buffer).toBe("New.");
  });

  test("a save made while disconnected waits, then is sent only if nothing changed meanwhile", () => {
    const state = conversationState();
    const daemon = new FakeDaemon();
    openLoaded(state, daemon, { conversation: "Base.", folder: "", global: "" });
    instructionsConnectionLost(state);
    daemon.connected = false;

    press(state, daemon, ENTER, "cc", "Offline edit.", ESC, ":wq", ENTER);
    expect(state.instructionsModal!.editor).toBeNull();
    expect(state.instructionsModal!.picker!.texts.conversation).toBe("Offline edit.");
    expect(sets(daemon)).toEqual([]);

    daemon.connected = true;
    instructionsReconnected(state, daemon);
    const check = daemon.last();
    expect(check).toMatchObject({ method: "loadInstructions", args: ["conv-1", null] });
    expect(sets(daemon)).toEqual([]);
    answerLoad(state, daemon, { conversation: "Base.", folder: null, global: "" });
    expect(sets(daemon).map(call => call.args)).toEqual([["conv-1", "Offline edit."]]);
    ack(state, daemon, sets(daemon)[0].reqId);
    expect(state.instructionsModal!.picker!.texts.conversation).toBe("Offline edit.");
  });

  test("a save waiting on a check fails, keeping its text, if the text changed elsewhere", () => {
    const state = conversationState();
    const daemon = new FakeDaemon();
    openLoaded(state, daemon, { conversation: "Base.", folder: "", global: "" });
    press(state, daemon, ESC);
    instructionsConnectionLost(state);
    instructionsReconnected(state, daemon);

    // Reopened from what the TUI had: the check is still out when :wq lands.
    openInstructionsPicker(state, daemon);
    press(state, daemon, ENTER, "cc", "Mine.", ESC, ":wq", ENTER);
    expect(sets(daemon)).toEqual([]);
    answerLoad(state, daemon, { conversation: "Theirs.", folder: "", global: "" });
    expect(sets(daemon)).toEqual([]);
    const picker = state.instructionsModal!.picker!;
    expect(picker.texts.conversation).toBe("Theirs.");
    expect(picker.failures.conversation).toBe("Changed elsewhere meanwhile");

    press(state, daemon, ENTER);
    const editor = state.instructionsModal!.editor!;
    expect(editor.buffer).toBe("Mine.");
    expect(editor.savedText).toBe("Theirs.");
    // Seen and chosen: :w now overwrites.
    press(state, daemon, ":w", ENTER);
    expect(sets(daemon).map(call => call.args)).toEqual([["conv-1", "Mine."]]);
  });

  test("a save sent just before the link dropped is checked, not blindly resent", () => {
    const landed = conversationState();
    const daemon = new FakeDaemon();
    openLoaded(landed, daemon, { conversation: "", folder: "Base.", global: "" });
    press(landed, daemon, "2", "cc", "Sent.", ESC, ":wq", ENTER);
    expect(sets(daemon)).toHaveLength(1);
    instructionsConnectionLost(landed);
    instructionsReconnected(landed, daemon);
    expect(daemon.last()).toMatchObject({ method: "loadInstructions", args: [null, "folder-1"] });
    // It landed: nothing to resend, nothing failed.
    answerLoad(landed, daemon, { conversation: "", folder: "Sent.", global: "" });
    expect(sets(daemon)).toHaveLength(1);
    expect(landed.instructionsModal!.picker!.texts.folder).toBe("Sent.");
    expect(landed.instructionsModal!.picker!.failures.folder).toBeNull();

    const lost = conversationState();
    const daemon2 = new FakeDaemon();
    openLoaded(lost, daemon2, { conversation: "", folder: "Base.", global: "" });
    press(lost, daemon2, "2", "cc", "Sent.", ESC, ":wq", ENTER);
    instructionsConnectionLost(lost);
    instructionsReconnected(lost, daemon2);
    // It never arrived and the daemon still has the base: send it again.
    answerLoad(lost, daemon2, { conversation: "", folder: "Base.", global: "" });
    expect(sets(daemon2).map(call => call.args)).toEqual([["folder-1", "Sent."], ["folder-1", "Sent."]]);
    handleInstructionsEvent(lost, { type: "folder_instructions_updated", reqId: sets(daemon2)[1].reqId, folderId: "folder-1", text: "Sent." }, daemon2);
    expect(lost.instructionsModal!.picker!.texts.folder).toBe("Sent.");
  });

  test("switching daemons forgets the texts and keeps unconfirmed saves recoverable", () => {
    const state = conversationState();
    const daemon = new FakeDaemon();
    openLoaded(state, daemon, { conversation: "", folder: "", global: "Old." });
    press(state, daemon, "3", "cc", "New.", ESC, ":wq", ENTER, ESC);
    instructionsRouteSwitched(state);
    const notice = state.messages.at(-1);
    expect(notice && "text" in notice ? notice.text : "").toContain("Global instructions were not saved: Not confirmed before switching daemons");

    openInstructionsPicker(state, daemon);
    expect(state.instructionsModal!.picker!.texts.global).toBeNull();
    answerLoad(state, daemon, { conversation: "", folder: "", global: "Other host." });
    press(state, daemon, "3");
    expect(state.instructionsModal!.editor!.buffer).toBe("New.");
    expect(state.instructionsModal!.editor!.savedText).toBe("Other host.");
  });
});

describe("instructions editor rendering", () => {
  const target = { convId: "conv-1", convTitle: "Trip planning", folderId: null, folderName: null };

  test("a centred card with the scope in the title, a mode line and key hints", () => {
    const editor = createInstructionsEditor("conversation", target, "Be brief.");
    const rendered = renderInstructionsEditor(editor, 40, 120);
    const shown = plain(rendered.payload);
    expect(shown).toContain("Conversation instructions · Trip planning");
    expect(shown).toContain("NORMAL");
    expect(shown).toContain("Ln 1, Col 1 · 1 line");
    expect(shown).toContain(":w save · :wq save & close · :q close · :q! discard");
    expect(shown).toContain("Be brief.");
    expect(rendered.rect.left - 1).toBe(120 - rendered.rect.right);
    expect(rendered.cursor).toEqual({ row: rendered.rect.top + 2, col: rendered.rect.left + 3, shape: "block" });
  });

  test("fits and wraps to any terminal size, keeping the cursor in view", () => {
    const long = Array.from({ length: 60 }, (_, i) => `line ${i} ${"word ".repeat(i % 7)}`).join("\n");
    const editor = createInstructionsEditor("global", target, long);
    for (const [rows, cols] of [[40, 120], [24, 80], [12, 40], [60, 200]] as const) {
      editor.cursor = long.length - 3;
      const rendered = renderInstructionsEditor(editor, rows, cols);
      expect(rendered.rect.top).toBeGreaterThanOrEqual(1);
      expect(rendered.rect.bottom).toBeLessThanOrEqual(rows);
      expect(rendered.rect.right).toBeLessThanOrEqual(cols);
      for (const row of rendered.payload.split(/\x1b\[\d+;\d+H/).slice(1)) {
        expect(termWidth(stripAnsi(row))).toBe(rendered.rect.right - rendered.rect.left + 1);
      }
      expect(rendered.cursor!.row).toBeGreaterThan(rendered.rect.top + 1);
      expect(rendered.cursor!.row).toBeLessThan(rendered.rect.bottom - 2);
      expect(editor.viewWidth).toBe(rendered.rect.right - rendered.rect.left + 1 - 6);
    }
  });

  test("an empty document shows a placeholder and an insert cursor", () => {
    const editor = createInstructionsEditor("folder", { ...target, folderId: "f", folderName: "Travel" }, "");
    const rendered = renderInstructionsEditor(editor, 40, 120);
    expect(plain(rendered.payload)).toContain("Instructions for every conversation in Travel/…");
    expect(plain(rendered.payload)).toContain("INSERT");
    expect(rendered.cursor?.shape).toBe("bar");
  });

  test("the command line shows what is typed after the colon", () => {
    const editor = createInstructionsEditor("global", target, "x");
    editor.command = "wq";
    const rendered = renderInstructionsEditor(editor, 40, 120);
    expect(plain(rendered.payload)).toContain(":wq");
    expect(plain(rendered.payload)).toContain("Enter run · Esc cancel");
    expect(rendered.cursor?.shape).toBe("bar");
  });
});

describe("summarizeInstructions", () => {
  test("first non-blank line and size", () => {
    expect(summarizeInstructions(null)).toBeNull();
    expect(summarizeInstructions("  \n")).toEqual({ preview: "", size: "" });
    expect(summarizeInstructions("\nOne\nTwo")).toEqual({ preview: "One", size: "2 lines · 7 chars" });
  });
});
