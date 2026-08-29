import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateAutocomplete } from "../autocomplete";
import { tryCommand } from "../commands";
import { createInitialState } from "../state";

const originalConfig = process.env.EXOCORTEX_SSH_CONFIG;
const tempDirs: string[] = [];

afterEach(() => {
  if (originalConfig === undefined) delete process.env.EXOCORTEX_SSH_CONFIG;
  else process.env.EXOCORTEX_SSH_CONFIG = originalConfig;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("/ssh", () => {
  test("parses status, connect, and cancel", () => {
    const state = createInitialState();
    expect(tryCommand("/ssh", state)).toEqual({ type: "ssh", action: "status" });
    expect(tryCommand("/ssh whale", state)).toEqual({ type: "ssh", action: "connect", alias: "whale" });
    expect(tryCommand("/ssh cancel", state)).toEqual({ type: "ssh", action: "cancel" });
  });

  test("rejects extra arguments and clears the prompt", () => {
    const state = createInitialState();
    state.inputBuffer = "/ssh whale extra";
    state.cursorPos = state.inputBuffer.length;

    expect(tryCommand(state.inputBuffer, state)).toEqual({ type: "handled" });
    expect(state.inputBuffer).toBe("");
    expect((state.messages.at(-1) as { text?: string }).text).toBe("Usage: /ssh [<ssh-alias>|cancel]");
  });

  test("autocompletes every concrete alias from the local SSH config", () => {
    const dir = mkdtempSync(join(tmpdir(), "exocortex-ssh-command-"));
    tempDirs.push(dir);
    mkdirSync(join(dir, ".ssh"), { recursive: true });
    const config = join(dir, ".ssh", "config");
    writeFileSync(config, "Host whale\nHost workbox\nHost *\n");
    process.env.EXOCORTEX_SSH_CONFIG = config;
    const state = createInitialState();
    state.inputBuffer = "/ssh w";
    state.cursorPos = state.inputBuffer.length;

    updateAutocomplete(state);

    expect(state.autocomplete?.matches.map(match => match.name)).toEqual(["whale", "workbox"]);
  });
});
