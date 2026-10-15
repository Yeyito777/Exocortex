import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DaemonClient } from "../../tui/src/client";
import type { AccountsEvent, Event } from "../../tui/src/protocol";

test("a real isolated daemon answers accounts with every registered Claude account", async () => {
  const root = resolve(import.meta.dir, "../..");
  const config = mkdtempSync(join(tmpdir(), "exo-accounts-ipc-"));
  const mainDir = join(config, "claude-main");
  const otherDir = join(config, "claude-max2");
  mkdirSync(mainDir, { recursive: true });
  mkdirSync(otherDir, { recursive: true });
  // Never inherit credentials or use the running daemon's files/socket; nothing here signs in.
  const env = {
    PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LANG: "C.UTF-8",
    EXOCORTEX_CONFIG_DIR: config, EXOCORTEX_TEST: "1",
    EXOCORTEX_SUPERVISE_EXTERNAL_DAEMONS: "0",
    CLAUDE_CONFIG_DIR: mainDir,
  };
  writeFileSync(join(config, "config.json"), JSON.stringify({ agent: { workingDirectory: config } }));
  const paths = Bun.spawnSync([process.execPath, "-e",
    'import { dataDir, socketPath } from "./shared/src/paths"; process.stdout.write(JSON.stringify({ data: dataDir(), socket: socketPath() }));'],
  { cwd: root, env });
  expect(paths.exitCode).toBe(0);
  const { data, socket } = JSON.parse(paths.stdout.toString()) as { data: string; socket: string };
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "anthropic-accounts.json"), JSON.stringify({ accounts: [{ id: "max2", configDir: otherDir }] }));

  const child = Bun.spawn([process.execPath, "run", "daemon/src/main.ts"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
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
  const events: Event[] = [];
  const client = new DaemonClient(event => { events.push(event); }, socket);
  try {
    await waitFor(() => output.includes("Waiting for connections"));
    await client.connect();
    const reqId = client.accounts({ convId: "conv-1" });
    await waitFor(() => events.some(event => event.type === "accounts" && event.reqId === reqId));
    const answer = events.find((event): event is AccountsEvent => event.type === "accounts" && event.reqId === reqId)!;
    expect(answer.snapshot.enabled).toBe(true);
    expect(answer.snapshot.claude.proxied).toBe(false);
    expect(answer.snapshot.claude.accounts.map(account => account.id)).toEqual(["main", "max2"]);
    const max2 = answer.snapshot.claude.accounts[1];
    expect(max2).toMatchObject({ state: "unchecked", activeTurns: 0, conversations: [] });
    expect(max2.loginCommand).toBe(`CLAUDE_CONFIG_DIR=${otherDir} command claude auth login --claudeai`);
    expect(answer.snapshot.claude.currentConversation).toEqual({ convId: "conv-1", account: null, lastUsedAt: null, warm: false });
    expect(answer.snapshot.claude.routing.cacheTtlMs).toBe(60 * 60_000);
    expect(answer.snapshot.openai).toEqual({ proxied: false, accounts: [] });

    // The text report is unchanged.
    client.account("anthropic");
    await waitFor(() => events.some(event => event.type === "auth_status" || event.type === "error"));
  } finally {
    client.disconnect();
    child.kill("SIGTERM");
    await child.exited;
    await Promise.all(pumps);
    rmSync(config, { recursive: true, force: true });
  }
}, 30_000);
