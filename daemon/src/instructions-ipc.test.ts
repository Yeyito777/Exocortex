import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DaemonClient } from "../../tui/src/client";
import { handleEvent } from "../../tui/src/events";
import { buildMessageLines } from "../../tui/src/conversation";
import { createInitialState } from "../../tui/src/state";
import { handleInstructionsModalKey, openInstructionsPicker } from "../../tui/src/instructions/controller";
import type { KeyEvent } from "../../tui/src/input";
import type { Event } from "../../tui/src/protocol";

test("real isolated daemon: the /instructions modal edits all three scopes and the model still gets them", async () => {
  const root = resolve(import.meta.dir, "../..");
  const config = mkdtempSync(join(tmpdir(), "exo-instructions-ipc-"));
  // Never inherit credentials or use the running daemon's files/socket.
  const env = {
    PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LANG: "C.UTF-8",
    EXOCORTEX_CONFIG_DIR: config, EXOCORTEX_TEST: "1",
    EXOCORTEX_SUPERVISE_EXTERNAL_DAEMONS: "0",
  };
  writeFileSync(join(config, "config.json"), JSON.stringify({ agent: { workingDirectory: config } }));
  // The tracked base, and a personal file from before the split that still holds it.
  const base = "# Upstream\nBase rule.";
  writeFileSync(join(config, "system.base.md"), `${base}\n`);
  writeFileSync(join(config, "system.md"), `${base}\n`);
  const pathResult = Bun.spawnSync([process.execPath, "-e",
    'import { socketPath } from "./shared/src/paths"; process.stdout.write(socketPath());'],
  { cwd: root, env });
  expect(pathResult.exitCode).toBe(0);
  const socketPath = pathResult.stdout.toString();
  const child = Bun.spawn([process.execPath, "run", "daemon/src/main.ts"], {
    cwd: root, env, stdout: "pipe", stderr: "pipe",
  });
  let output = "";
  const pumps = [child.stdout, child.stderr].map(async stream => {
    for await (const chunk of stream) output = (output + new TextDecoder().decode(chunk)).slice(-32_000);
  });
  const waitFor = async (predicate: () => boolean, what: string) => {
    const deadline = Date.now() + 15_000;
    while (!predicate()) {
      if (child.exitCode !== null || Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}: ${output}`);
      await Bun.sleep(10);
    }
  };
  const state = createInitialState();
  const events: Event[] = [];
  const client = new DaemonClient(event => { events.push(event); handleEvent(event, state, client); }, socketPath);
  const press = (...keys: Array<string | KeyEvent>) => {
    for (const key of keys) {
      const events: KeyEvent[] = typeof key === "string" ? [...key].map(char => ({ type: "char", char })) : [key];
      for (const event of events) {
        const outcome = handleInstructionsModalKey(event, state, client);
        expect(outcome.type).toBe("handled");
      }
    }
  };
  const ESC: KeyEvent = { type: "escape" };
  const ENTER: KeyEvent = { type: "enter" };
  const picker = () => state.instructionsModal?.picker ?? null;
  const editor = () => state.instructionsModal?.editor ?? null;
  // Leaving an editor closes /instructions; this opens it again on a scope.
  const reopen = (scope: "conversation" | "folder" | "global" = "conversation") => openInstructionsPicker(state, client, scope);
  // Saves show at once; this is when the daemon has confirmed them all.
  const settled = () => [...state.instructionsStore.entries.values()].every(entry => entry.saves.length === 0);
  try {
    await waitFor(() => output.includes("Waiting for connections"), "daemon");
    await client.connect();

    client.send({ type: "new_conversation", reqId: "instructions-create" });
    await waitFor(() => events.some(event => event.type === "conversation_created"), "conversation");
    const created = events.find(event => event.type === "conversation_created");
    if (created?.type !== "conversation_created") throw new Error("No conversation");
    const convId = created.convId;
    client.send({ type: "create_folder", reqId: "instructions-folder", name: "Project", items: [{ type: "conversation", id: convId }] });
    await waitFor(() => events.some(event => event.type === "ack" && event.reqId === "instructions-folder"), "folder");
    client.listConversations();
    await waitFor(() => state.sidebar.conversations.some(conv => conv.id === convId && conv.folderId), "sidebar");
    const folderId = state.sidebar.conversations.find(conv => conv.id === convId)!.folderId!;
    state.convId = convId;
    client.loadConversation(convId);

    // /instructions: the picker loads every scope.
    openInstructionsPicker(state, client);
    await waitFor(() => picker()?.loadReqId === null, "picker load");
    expect(picker()!.target).toMatchObject({ convId, folderId, folderName: "Project" });
    expect(picker()!.texts).toEqual({ conversation: "", folder: "", global: "" });
    // Starting the daemon moved the duplicated base out of the personal file, after a backup.
    expect(readFileSync(join(config, "system.md"), "utf8")).toBe("");
    const backups = readdirSync(config).filter(name => name.startsWith("system.md.pre-split-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(config, backups[0]), "utf8")).toBe(`${base}\n`);
    const loaded = events.find(event => event.type === "instructions_loaded");
    if (loaded?.type !== "instructions_loaded") throw new Error("No instructions_loaded");
    expect(loaded.global).toBe("");
    expect(loaded.globalBase).toBe(base);
    expect(state.instructionsStore.globalBase).toBe(base);

    // Conversation: empty, so the editor starts in insert mode.
    press(ENTER);
    expect(editor()?.scope).toBe("conversation");
    expect(editor()!.vim.mode).toBe("insert");
    press("Answer in haiku.", ESC, ":wq", ENTER);
    // :wq leaves /instructions; reopening shows the save at once.
    expect(state.instructionsModal).toBeNull();
    reopen();
    expect(picker()!.texts.conversation).toBe("Answer in haiku.");
    await waitFor(settled, "conversation save");
    expect(picker()!.texts.conversation).toBe("Answer in haiku.");

    // Folder: write, save with Ctrl-S, then :q once clean.
    press("j", ENTER, "Project rules.", { type: "ctrl-s" });
    expect(editor()?.notice?.text).toBe("Saved");
    await waitFor(settled, "folder save");
    press(ESC, ":q", ENTER);
    expect(state.instructionsModal).toBeNull();
    reopen("folder");
    expect(picker()!.texts.folder).toBe("Project rules.");

    // Global: the base shows above the editable text and is never saved.
    press("j", ENTER);
    expect(editor()?.scope).toBe("global");
    expect(editor()!.base).toBe(base);
    expect(editor()!.buffer).toBe("");
    press("Global rule.", ESC, ":wq", ENTER);
    expect(state.instructionsModal).toBeNull();
    await waitFor(settled, "global save");
    reopen("global");
    expect(picker()!.texts).toEqual({ conversation: "Answer in haiku.", folder: "Project rules.", global: "Global rule." });
    expect(readFileSync(join(config, "system.md"), "utf8")).toBe("Global rule.\n");

    // Reopening shows the saved text.
    press("k", "k", ENTER);
    expect(editor()?.buffer).toBe("Answer in haiku.");
    expect(editor()!.vim.mode).toBe("normal");
    press(ESC);
    expect(state.instructionsModal).toBeNull();

    // The model's context still carries all three.
    client.send({ type: "get_system_prompt", reqId: "instructions-prompt", convId });
    await waitFor(() => events.some(event => event.type === "system_prompt"), "system prompt");
    const prompt = events.find(event => event.type === "system_prompt");
    if (prompt?.type !== "system_prompt") throw new Error("No system prompt");
    expect(prompt.systemPrompt).toContain("Answer in haiku.");
    expect(prompt.systemPrompt).toContain("Project rules.");
    expect(prompt.systemPrompt).toContain(`${base}\n\nGlobal rule.`);
    expect(prompt.systemPrompt.split("Base rule.").length).toBe(2);
    expect(readFileSync(join(config, "system.base.md"), "utf8")).toBe(`${base}\n`);

    // The history still receives both as pinned entries, and renders neither.
    await waitFor(() => state.messages.filter(message => message.role === "system_instructions").length === 2, "pinned instructions");
    // (Drop the local /system notice the prompt answer was shown as.)
    state.messages = state.messages.filter(message => message.role !== "system");
    const rendered = buildMessageLines(state, 100).lines.join("\n");
    expect(rendered).not.toContain("Answer in haiku.");
    expect(rendered).not.toContain("Project rules.");

    // Global: an edit made elsewhere meanwhile is not overwritten without :w!.
    reopen();
    await waitFor(() => picker()?.loadReqId === null, "reopened picker load");
    writeFileSync(join(config, "system.md"), "Edited elsewhere.\n");
    press("G", ENTER);
    expect(editor()?.scope).toBe("global");
    press("A", " More.", ESC, ":w", ENTER);
    await waitFor(() => editor()?.notice?.tone === "error", "global conflict");
    expect(editor()!.notice!.text).toContain(":w! overwrites");
    expect(readFileSync(join(config, "system.md"), "utf8")).toBe("Edited elsewhere.\n");
    press(":w!", ENTER);
    expect(editor()?.notice?.text).toBe("Saved");
    await waitFor(settled, "forced global save");
    expect(readFileSync(join(config, "system.md"), "utf8")).toBe("Global rule. More.\n");

    // Clearing a scope (saving it empty) removes it.
    press(ESC);
    expect(state.instructionsModal).toBeNull();
    reopen("folder");
    press(ENTER, "dd", ":wq", ENTER);
    expect(state.instructionsModal).toBeNull();
    await waitFor(settled, "folder clear");
    reopen("folder");
    expect(picker()!.texts.folder).toBe("");
    events.length = 0;
    client.send({ type: "get_system_prompt", reqId: "instructions-prompt-2", convId });
    await waitFor(() => events.some(event => event.type === "system_prompt"), "second system prompt");
    const cleared = events.find(event => event.type === "system_prompt");
    if (cleared?.type !== "system_prompt") throw new Error("No system prompt");
    expect(cleared.systemPrompt).not.toContain("Project rules.");
    expect(cleared.systemPrompt).toContain("Answer in haiku.");
  } finally {
    client.disconnect();
    child.kill("SIGTERM");
    await child.exited;
    await Promise.all(pumps);
    rmSync(config, { recursive: true, force: true });
  }
}, 30_000);
