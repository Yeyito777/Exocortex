import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DaemonClient } from "../../tui/src/client";
import { handleEvent } from "../../tui/src/events";
import { tryCommand } from "../../tui/src/commands";
import { createInitialState, resetNewConversationDefaults } from "../../tui/src/state";
import { clearConversationDefaults, configuredConversationDefaults, productConversationDefaults, saveConversationDefaults } from "@exocortex/shared/config";
import type { Event } from "../../tui/src/protocol";

test("real isolated daemon owns persistence and broadcasts defaults to connected TUIs", async () => {
  const root = resolve(import.meta.dir, "../..");
  const config = mkdtempSync(join(tmpdir(), "exo-defaults-ipc-"));
  // Never inherit credentials or use the running daemon's files/socket.
  const env = {
    PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LANG: "C.UTF-8",
    EXOCORTEX_CONFIG_DIR: config, EXOCORTEX_TEST: "1",
    EXOCORTEX_SUPERVISE_EXTERNAL_DAEMONS: "0",
  };
  const initialDefaults = { provider: "openai", model: "gpt-6-astra", effort: "low", fastMode: false } as const;
  writeFileSync(join(config, "config.json"), JSON.stringify({
    agent: { workingDirectory: config }, defaults: { conversation: initialDefaults },
  }));
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
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 15_000;
    while (!predicate()) {
      if (child.exitCode !== null || Date.now() >= deadline) throw new Error(`Isolated daemon not ready: ${output}`);
      await Bun.sleep(10);
    }
  };
  const state = createInitialState();
  const otherState = createInitialState();
  const events: Event[] = [];
  const otherEvents: Event[] = [];
  const client = new DaemonClient(event => { events.push(event); handleEvent(event, state, client); }, socketPath);
  const other = new DaemonClient(event => { otherEvents.push(event); handleEvent(event, otherState, other); }, socketPath);
  try {
    await waitFor(() => output.includes("Waiting for connections"));
    await client.connect();
    await other.connect();
    // The TUI test process has different local config from the actual child daemon.
    saveConversationDefaults({ provider: "deepseek", model: "local-only", effort: "max", fastMode: false });
    client.ping();
    other.ping();
    await waitFor(() => state.conversationDefaults !== null && otherState.conversationDefaults !== null);
    expect(state.conversationDefaults).toEqual({ configured: true, defaults: initialDefaults });
    expect(state.model).toBe("gpt-6-astra");
    otherState.hasChosenProvider = true;
    otherState.model = "edited-draft";

    const action = tryCommand("/default-model deepseek pro max off", state)!;
    expect(action.type).toBe("conversation_defaults_changed");
    if (action.type !== "conversation_defaults_changed") throw new Error("Wrong defaults action");
    client.setConversationDefaults(action.defaults);
    await waitFor(() => events.some(event => event.type === "conversation_defaults" && Boolean(event.message)));
    await waitFor(() => otherState.conversationDefaults?.defaults.provider === "deepseek");
    expect(state.conversationDefaults?.defaults).toEqual(action.defaults);
    expect(state.model).toBe("deepseek-v4-pro");
    expect(otherState.model).toBe("edited-draft");
    expect(otherEvents.filter(event => event.type === "conversation_defaults" && Boolean(event.message))).toEqual([]);
    const hostConfig = () => JSON.parse(readFileSync(join(config, "config.json"), "utf8"));
    expect(hostConfig().defaults.conversation).toEqual(action.defaults);
    resetNewConversationDefaults(otherState);
    expect(otherState.model).toBe("deepseek-v4-pro");

    client.send({ type: "new_conversation", reqId: "defaults-smoke-create" });
    await waitFor(() => events.some(event => event.type === "conversation_created"));
    const created = events.find(event => event.type === "conversation_created")!;
    expect(created).toMatchObject(action.defaults);
    client.setConversationDefaults({ ...action.defaults, fastMode: true });
    await waitFor(() => events.some(event => event.type === "error"));
    expect(hostConfig().defaults.conversation).toEqual(action.defaults);

    client.resetConversationDefaults();
    await waitFor(() => state.conversationDefaults?.configured === false && otherState.conversationDefaults?.configured === false);
    expect(state.conversationDefaults?.defaults).toEqual(productConversationDefaults());
    expect(hostConfig().defaults?.conversation).toBeUndefined();
    expect(configuredConversationDefaults()?.model).toBe("local-only");
    // Reset does not change the already-created conversation's selection.
    expect(state.model).toBe("deepseek-v4-pro");
  } finally {
    client.disconnect();
    other.disconnect();
    child.kill("SIGTERM");
    await child.exited;
    await Promise.all(pumps);
    rmSync(config, { recursive: true, force: true });
    clearConversationDefaults();
  }
}, 30_000);
