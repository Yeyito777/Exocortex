import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "../input";
import type { ToolInstructionsLoadedEvent } from "../protocol";
import { createInitialState, type RenderState } from "../state";
import { stripAnsi } from "../historycursor";
import {
  handleInstructionsEvent,
  handleInstructionsModalKey,
  openInstructionsScope,
  openToolInstructions,
  type InstructionsDaemon,
  type ToolInstructionsLoader,
} from "./controller";
import { renderInstructionsEditor } from "./render";
import { buildToolInstructionsDoc, sectionAt, sectionSourceNotice, shortSource } from "./tools";

class FakeDaemon implements InstructionsDaemon, ToolInstructionsLoader {
  connected = true;
  calls: Array<{ method: string; args: unknown[]; reqId: string }> = [];
  private next = 0;
  private record(method: string, args: unknown[]): string {
    const reqId = `${method}-${++this.next}`;
    this.calls.push({ method, args, reqId });
    return reqId;
  }
  loadInstructions(convId: string | null, folderId: string | null) { return this.record("loadInstructions", [convId, folderId]); }
  loadToolInstructions(convId: string | null, provider: string, model: string) { return this.record("loadToolInstructions", [convId, provider, model]); }
  setSystemInstructions(convId: string, text: string) { return this.record("setSystemInstructions", [convId, text]); }
  setFolderInstructions(folderId: string, text: string) { return this.record("setFolderInstructions", [folderId, text]); }
  setGlobalInstructions(text: string, expectedText?: string) { return this.record("setGlobalInstructions", [text, expectedText]); }
  last(method: string) { return this.calls.filter(call => call.method === method).at(-1)!; }
  writes() { return this.calls.filter(call => call.method.startsWith("set")); }
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

function press(state: RenderState, daemon: FakeDaemon, ...input: Array<string | KeyEvent>): void {
  for (const item of input) {
    const events: KeyEvent[] = typeof item === "string" ? [...item].map(char => ({ type: "char", char })) : [item];
    for (const key of events) handleInstructionsModalKey(key, state, daemon);
  }
}

function plain(payload: string): string {
  return stripAnsi(payload.replace(/\x1b\[\d+;\d+H/g, "\n"));
}

const ANSWER: Omit<ToolInstructionsLoadedEvent, "type" | "reqId"> = {
  convId: "conv-1",
  provider: "openai",
  model: "gpt-6.1-sol",
  route: "Exocortex system prompt: tool schemas carry the descriptions.",
  internal: [
    { name: "exo", source: "/repo/daemon/src/tools/exo.ts", description: "Start a subagent.", hint: "Subagents are the default for real work." },
    { name: "chrono", source: "/repo/daemon/src/tools/chrono.ts", description: "Schedule wakes." },
  ],
  external: [
    { name: "cal", source: "/repo/external-tools/cal-cli/manifest.json", hint: "Use `cal -h`.\nNever edit storage." },
    { name: "discord", source: "/repo/external-tools/discord-cli/manifest.json", hint: "Use `discord -h`." },
  ],
};

function openTools(state = conversationState(), daemon = new FakeDaemon()) {
  openToolInstructions(state, daemon);
  const call = daemon.last("loadToolInstructions");
  handleInstructionsEvent(state, { type: "tool_instructions_loaded", reqId: call.reqId, ...ANSWER }, daemon);
  return { state, daemon, editor: state.instructionsModal!.editor! };
}

function lineAtCursor(buffer: string, cursor: number): string {
  const start = buffer.lastIndexOf("\n", cursor - 1) + 1;
  const end = buffer.indexOf("\n", cursor);
  return buffer.slice(start, end === -1 ? undefined : end);
}

describe("/instructions <scope>", () => {
  test("conversation, folder and global open that editor directly; :q closes rather than showing the picker", () => {
    for (const [scope, method] of [["conversation", "setSystemInstructions"], ["folder", "setFolderInstructions"], ["global", "setGlobalInstructions"]] as const) {
      const state = conversationState();
      const daemon = new FakeDaemon();
      openInstructionsScope(state, daemon, scope);
      const modal = state.instructionsModal!;
      expect(modal.picker).toBeNull();
      expect(modal.editor?.scope).toBe(scope);
      expect(modal.editor?.loadReqId).toBe(daemon.last("loadInstructions").reqId);
      expect(daemon.last("loadInstructions").args).toEqual(["conv-1", "folder-1"]);

      handleInstructionsEvent(state, {
        type: "instructions_loaded", reqId: daemon.last("loadInstructions").reqId, convId: "conv-1", folderId: "folder-1",
        conversation: "convo text", folder: "folder text", global: "global text",
      }, daemon);
      expect(state.instructionsModal!.editor!.buffer).toBe(`${scope === "conversation" ? "convo" : scope} text`);

      press(state, daemon, "A", " more", { type: "escape" }, ":wq", { type: "enter" });
      expect(daemon.last(method).args).toContain(`${scope === "conversation" ? "convo" : scope} text more`);
      expect(state.instructionsModal).toBeNull();
    }
  });

  test("a scope the TUI already has opens without waiting", () => {
    const state = conversationState();
    const daemon = new FakeDaemon();
    openInstructionsScope(state, daemon, "global");
    handleInstructionsEvent(state, {
      type: "instructions_loaded", reqId: daemon.last("loadInstructions").reqId, convId: "conv-1", folderId: "folder-1",
      conversation: "", folder: "", global: "Be brief",
    }, daemon);
    press(state, daemon, ":q", { type: "enter" });

    openInstructionsScope(state, daemon, "global");
    expect(state.instructionsModal!.editor!.loadReqId).toBeNull();
    expect(state.instructionsModal!.editor!.buffer).toBe("Be brief");
  });

  test("folder outside a folder says so instead of opening", () => {
    const state = conversationState(false);
    const daemon = new FakeDaemon();
    openInstructionsScope(state, daemon, "folder");
    expect(state.instructionsModal).toBeNull();
    expect(daemon.calls).toEqual([]);
    expect(state.messages.at(-1)).toMatchObject({ role: "system", text: expect.stringContaining("not in a folder") });
  });

  test("conversation in a draft edits what the new conversation starts with", () => {
    const state = createInitialState();
    state.pendingSystemInstructions = "queued";
    const daemon = new FakeDaemon();
    openInstructionsScope(state, daemon, "conversation");
    const editor = state.instructionsModal!.editor!;
    expect(editor.loadReqId).toBeNull();
    expect(editor.buffer).toBe("queued");
  });
});

describe("/instructions tools", () => {
  test("asks the daemon for this conversation's route and waits for it", () => {
    const state = conversationState();
    const daemon = new FakeDaemon();
    openToolInstructions(state, daemon);
    expect(daemon.last("loadToolInstructions").args).toEqual(["conv-1", state.provider, state.model]);
    const editor = state.instructionsModal!.editor!;
    expect(editor.loadReqId).not.toBeNull();
    expect(plain(renderInstructionsEditor(editor, 30, 100).payload)).toContain("Loading…");
  });

  test("internal and external sections in order, each tool with its texts", () => {
    const { editor } = openTools();
    const doc = editor.tools!;
    expect(doc.sections.map(section => `${section.kind}:${section.name}`)).toEqual([
      "group:Internal tools", "tool:exo", "tool:chrono", "group:External tools", "tool:cal", "tool:discord",
    ]);
    expect(doc.sections.find(section => section.name === "Internal tools")?.count).toBe(2);
    for (const section of doc.sections) expect(lineAtCursor(editor.buffer, section.offset)).toBe(section.name);
    expect(editor.buffer).toContain("Description · tool schema\nStart a subagent.\n\nSystem prompt · # Internal tools\nSubagents are the default for real work.");
    expect(editor.buffer).toContain("cal\nSystem prompt · manifest systemHint\nUse `cal -h`.\nNever edit storage.");
    expect(editor.buffer.startsWith(ANSWER.route)).toBe(true);
  });

  test("separators are drawn, never part of the text", () => {
    const { editor } = openTools();
    expect(editor.buffer).not.toMatch(/[─━]/);
    const shown = plain(renderInstructionsEditor(editor, 60, 110).payload);
    expect(shown).toMatch(/━━ Internal tools · 2 ━+/);
    expect(shown).toMatch(/── exo ─+ daemon\/src\/tools\/exo\.ts ──/);
    expect(shown).toMatch(/━━ External tools · 2 ━+/);
    expect(shown).toMatch(/── cal ─+ external-tools\/cal-cli\/manifest\.json ──/);
    expect(shown).toContain("Tool instructions · openai · gpt-6.1-sol");
    expect(shown).toContain("read-only");
    expect(shown).toContain("]] [[ tool");
    // A long source keeps its file name in the status line.
    editor.notice = { text: `cal: /very/long/${"deep/".repeat(30)}external-tools/cal-cli/manifest.json`, tone: "info" };
    expect(plain(renderInstructionsEditor(editor, 60, 110).payload)).toMatch(/…[\w/-]*external-tools\/cal-cli\/manifest\.json/);
    // The rule replaces the header line's own text.
    expect(shown).not.toMatch(/^\s*│\s+exo\s+│/m);
  });

  test("]] and [[ move by tool, } and { by group, with counts", () => {
    const { state, daemon, editor } = openTools();
    const at = () => sectionAt(editor.tools!, editor.cursor)?.name;
    const onHeader = () => editor.tools!.sections.some(section => section.offset === editor.cursor);

    press(state, daemon, "]]");
    expect(at()).toBe("exo");
    expect(onHeader()).toBe(true);
    press(state, daemon, "]]");
    expect(at()).toBe("chrono");
    press(state, daemon, "]]");
    expect(at()).toBe("cal");
    press(state, daemon, "[[");
    expect(at()).toBe("chrono");
    press(state, daemon, "}");
    expect(at()).toBe("External tools");
    press(state, daemon, "{");
    expect(at()).toBe("Internal tools");
    press(state, daemon, "gg", "3]]");
    expect(at()).toBe("cal");
    press(state, daemon, "]]", "]]");
    expect(at()).toBe("discord");
    expect(editor.notice?.text).toBe("No tool below");
    // A lone ] followed by another key is not a jump.
    press(state, daemon, "gg", "]", "j");
    expect(at()).not.toBe("exo");
  });

  test("a jump scrolls the section to the top of a long document", () => {
    const state = conversationState();
    const daemon = new FakeDaemon();
    openToolInstructions(state, daemon);
    const long = { ...ANSWER, external: Array.from({ length: 30 }, (_, i) => ({ name: `tool${i}`, source: `/r/external-tools/t${i}/manifest.json`, hint: "line one\nline two" })) };
    handleInstructionsEvent(state, { type: "tool_instructions_loaded", reqId: daemon.last("loadToolInstructions").reqId, ...long }, daemon);
    const editor = state.instructionsModal!.editor!;
    renderInstructionsEditor(editor, 30, 100);
    press(state, daemon, "}}", "]]".repeat(10));
    expect(sectionAt(editor.tools!, editor.cursor)?.name).toBe("tool9");
    const shown = plain(renderInstructionsEditor(editor, 30, 100).payload).split("\n").filter(line => line.includes("│"));
    // The section is on the first body rows, after one row of context.
    expect(shown.slice(0, 3).some(line => line.includes("── tool9 "))).toBe(true);
  });

  test("Enter and gf show where the section under the cursor comes from", () => {
    const { state, daemon, editor } = openTools();
    press(state, daemon, "]]", "j", { type: "enter" });
    expect(editor.notice?.text).toBe("exo: /repo/daemon/src/tools/exo.ts");
    press(state, daemon, "}", "]]", "gf");
    expect(editor.notice?.text).toBe("cal: /repo/external-tools/cal-cli/manifest.json");
    press(state, daemon, "gg", "gf");
    expect(editor.notice?.text).toBe(ANSWER.route);
    expect(sectionSourceNotice(editor.tools!, editor.tools!.sections[1].offset, "/repo")).toBe("exo: ~/daemon/src/tools/exo.ts");
    // gg still goes to the top.
    expect(editor.cursor).toBe(0);
  });

  test("read-only: no edit, paste, undo or save gets through, and :wq just closes", () => {
    const attempts: Array<Array<string | KeyEvent>> = [
      ["i", "typed"], ["a", "x"], ["o", "new line"], ["A", "z"], ["dd"], ["x"], ["cwword"], ["Vd"], ["vjd"], [">>"], ["~"], ["rX"], ["J"],
      ["p"], ["P"], ["u"], [{ type: "ctrl-s" }], [{ type: "paste", text: "pasted" }], [":w", { type: "enter" }], [":w!", { type: "enter" }],
    ];
    for (const attempt of attempts) {
      const { state, daemon, editor } = openTools();
      const text = editor.buffer;
      press(state, daemon, "]]", "j", ...attempt);
      expect(editor.buffer).toBe(text);
      expect(editor.vim.mode).not.toBe("insert");
      expect(state.instructionsModal?.editor).toBe(editor);
      expect(daemon.writes()).toEqual([]);
    }
    const { state, daemon, editor } = openTools();
    press(state, daemon, "i");
    expect(editor.vim.mode).toBe("normal");
    expect(editor.notice?.text).toContain("Read-only");
    expect(daemon.writes()).toEqual([]);

    press(state, daemon, ":wq", { type: "enter" });
    expect(state.instructionsModal).toBeNull();
    expect(daemon.writes()).toEqual([]);
  });

  test("motions, visual selection and yank still work", () => {
    const { state, daemon, editor } = openTools();
    press(state, daemon, "G");
    expect(editor.cursor).toBeGreaterThan(0);
    press(state, daemon, "gg", "V", "j");
    expect(editor.vim.mode).toBe("visual-line");
    press(state, daemon, { type: "escape" }, { type: "escape" });
    expect(state.instructionsModal).toBeNull();
  });

  test("a daemon error closes the view and leaves the error to the chat", () => {
    const state = conversationState();
    const daemon = new FakeDaemon();
    openToolInstructions(state, daemon);
    const consumed = handleInstructionsEvent(state, { type: "error", reqId: daemon.last("loadToolInstructions").reqId, message: "Unknown command" }, daemon);
    expect(consumed).toBe(false);
    expect(state.instructionsModal).toBeNull();
  });

  test("a route without tools says so", () => {
    const { text, doc } = buildToolInstructionsDoc({ provider: "openrouter", model: "hermes", route: "No tools.", internal: [], external: [] });
    expect(doc.sections.map(section => section.name)).toEqual(["Internal tools", "External tools"]);
    expect(text).toContain("None on this route.");
  });

  test("source paths shorten to their place in the checkout", () => {
    expect(shortSource("/home/u/Exocortex/daemon/src/tools/exo.ts")).toBe("daemon/src/tools/exo.ts");
    expect(shortSource("/home/u/Exocortex/external-tools/cal-cli/manifest.json")).toBe("external-tools/cal-cli/manifest.json");
    expect(shortSource("/opt/tools/cal/manifest.json")).toBe("cal/manifest.json");
  });
});
