import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { dataDir } from "@exocortex/shared/paths";
import type { StreamOptions } from "../types";
import { agentTurnOptions, prunedSessionAlias } from "./api";
import { CLAUDE_SESSION_ALIASES_FILE, claudeProjectDirName, writeClaudeSessionAliases } from "./session-prune";

describe("Claude Code turn options", () => {
  test("disallow Claude Code's own subagent tool and schedulers, leaving delegation to exo and chrono", () => {
    const options = agentTurnOptions(
      "claude-opus-5-5" as never,
      { system: "" } as StreamOptions,
      "/work",
      { pending: [] } as never,
      () => {},
      async () => { throw new Error("unused"); },
      "main",
    );
    expect(options.disallowedTools).toEqual(expect.arrayContaining(["Agent", "Task", "AskUserQuestion", "ScheduleWakeup"]));
  });
});

describe("resuming a pruned session", () => {
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  let scratch = "";
  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    rmSync(join(dataDir(), CLAUDE_SESSION_ALIASES_FILE), { force: true });
  });

  test("resumes the kept session its alias names, only once its own file is gone", () => {
    scratch = mkdtempSync(join(tmpdir(), "claude-alias-"));
    process.env.CLAUDE_CONFIG_DIR = scratch;
    const cwd = "/work/conversation";
    const dir = join(scratch, "projects", claudeProjectDirName(cwd));
    mkdirSync(dir, { recursive: true });
    mkdirSync(dataDir(), { recursive: true });
    writeClaudeSessionAliases(join(dataDir(), CLAUDE_SESSION_ALIASES_FILE), { old: "kept", gone: "missing" });
    writeFileSync(join(dir, "kept.jsonl"), "");
    const resume = (sessionId: string) => ({ sessionId, resumeAt: "u1", cwd });
    expect(prunedSessionAlias(resume("old"), "main")).toBe("kept");
    // Its alias's file is gone too: nothing to resume from, as before.
    expect(prunedSessionAlias(resume("gone"), "main")).toBeNull();
    // Still on disk: resumed as recorded.
    writeFileSync(join(dir, "old.jsonl"), "");
    expect(prunedSessionAlias(resume("old"), "main")).toBeNull();
  });
});
