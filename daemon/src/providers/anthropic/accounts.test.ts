import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  addClaudeAccount,
  claudeAccountEnv,
  claudeLoginCommand,
  getClaudeAccount,
  listClaudeAccounts,
  MAIN_ACCOUNT_ID,
  removeClaudeAccount,
  setClaudeAccountsFileForTests,
} from "./accounts";
import { claudeProcessOptions } from "./cli";

let dir: string;
let mainDir: string;
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "exo-claude-accounts-"));
  mainDir = join(dir, "main-claude");
  mkdirSync(join(mainDir, "projects"), { recursive: true });
  mkdirSync(join(mainDir, "skills"));
  writeFileSync(join(mainDir, "settings.json"), "{}");
  writeFileSync(join(mainDir, ".credentials.json"), "{\"secret\":true}");
  process.env.CLAUDE_CONFIG_DIR = mainDir;
  setClaudeAccountsFileForTests(join(dir, "accounts.json"));
});

afterEach(() => {
  setClaudeAccountsFileForTests(null);
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("Claude accounts", () => {
  test("main is the existing login and adds nothing to Claude Code's environment", () => {
    expect(listClaudeAccounts()).toEqual([{ id: MAIN_ACCOUNT_ID, configDir: mainDir }]);
    expect(claudeAccountEnv(MAIN_ACCOUNT_ID)).toEqual({});
    expect(claudeAccountEnv(undefined)).toEqual({});
  });

  test("adding an account creates its directory, shares sessions and settings, never the login", () => {
    const accountDir = join(dir, "claude-max2");
    const added = addClaudeAccount("Max2", accountDir);
    expect(added.account).toMatchObject({ id: "max2", configDir: accountDir, managed: true });
    expect(added.linked.sort()).toEqual(["projects", "settings.json", "skills"]);
    expect(readlinkSync(join(accountDir, "projects"))).toBe(join(mainDir, "projects"));
    expect(lstatSync(join(accountDir, "settings.json")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(accountDir, ".credentials.json"))).toBe(false);
    expect(existsSync(join(accountDir, ".claude.json"))).toBe(false);
    expect(listClaudeAccounts().map(account => account.id)).toEqual(["main", "max2"]);
    expect(claudeAccountEnv("max2")).toEqual({ CLAUDE_CONFIG_DIR: accountDir });
  });

  test("Claude Code processes for an account get its config dir; main keeps the default", () => {
    const accountDir = join(dir, "claude-max2");
    addClaudeAccount("max2", accountDir);
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test";
    try {
      expect(claudeProcessOptions("/work", "max2").env).toMatchObject({ CLAUDE_CONFIG_DIR: accountDir });
      expect(claudeProcessOptions("/work", "max2").env?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(claudeProcessOptions("/work").env?.CLAUDE_CONFIG_DIR).toBe(mainDir);
    } finally {
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  test("the login command uses Claude Code's own login with the account's directory, skipping aliases", () => {
    const accountDir = join(dir, "claude max2");
    const { account } = addClaudeAccount("max2", accountDir);
    expect(claudeLoginCommand(account)).toBe(`CLAUDE_CONFIG_DIR='${accountDir}' command claude auth login --claudeai`);
    expect(claudeLoginCommand(getClaudeAccount("main")!)).toBe("command claude auth login --claudeai");
  });

  test("rejects bad names, duplicates and the main directory", () => {
    expect(() => addClaudeAccount("main")).toThrow("existing Claude Code login");
    expect(() => addClaudeAccount("no spaces", join(dir, "x"))).toThrow("lowercase");
    expect(() => addClaudeAccount("other", mainDir)).toThrow("main account's directory");
    addClaudeAccount("max2", join(dir, "a"));
    expect(() => addClaudeAccount("max2", join(dir, "b"))).toThrow("already exists");
    expect(() => addClaudeAccount("max3", join(dir, "a"))).toThrow("already belongs");
    expect(() => claudeAccountEnv("nope")).toThrow("Unknown Claude account");
  });

  test("removing unregisters but leaves the directory and login alone", () => {
    const accountDir = join(dir, "claude-max2");
    addClaudeAccount("max2", accountDir);
    writeFileSync(join(accountDir, ".credentials.json"), "{}");
    removeClaudeAccount("max2");
    expect(listClaudeAccounts().map(account => account.id)).toEqual(["main"]);
    expect(existsSync(join(accountDir, ".credentials.json"))).toBe(true);
    expect(() => removeClaudeAccount("main")).toThrow("cannot be removed");
  });
});
