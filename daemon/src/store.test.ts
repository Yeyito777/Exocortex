import { afterEach, beforeAll, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { secretsDir } from "@exocortex/shared/paths";
import { loadProviderAuth, saveProviderAuth } from "./store";

const credFile = join(secretsDir(), "credentials.json");

beforeAll(() => {
  // These tests delete credential files: never against a real config.
  if (!secretsDir().startsWith(tmpdir())) throw new Error(`refusing to run against ${secretsDir()}`);
});

afterEach(() => {
  for (const name of existsSync(secretsDir()) ? readdirSync(secretsDir()) : []) {
    if (name.startsWith("credentials.json")) unlinkSync(join(secretsDir(), name));
  }
});

test("an unreadable credentials file is kept aside instead of being overwritten by one provider", () => {
  mkdirSync(secretsDir(), { recursive: true });
  // E.g. truncated by a crash mid-write: the other providers' logins are in here.
  writeFileSync(credFile, '{"version":2,"providers":{"openai":{"tok');
  saveProviderAuth("deepseek", { apiKey: "k" });

  expect(loadProviderAuth("deepseek")).toEqual({ apiKey: "k" });
  const kept = readdirSync(secretsDir()).filter(name => name.startsWith("credentials.json.corrupt-"));
  expect(kept).toHaveLength(1);
  expect(readFileSync(join(secretsDir(), kept[0]), "utf-8")).toBe('{"version":2,"providers":{"openai":{"tok');
});

test("credentials are replaced atomically with owner-only permissions", () => {
  saveProviderAuth("deepseek", { apiKey: "a" });
  saveProviderAuth("openrouter", { apiKey: "b" });
  expect(loadProviderAuth("deepseek")).toEqual({ apiKey: "a" });
  expect(loadProviderAuth("openrouter")).toEqual({ apiKey: "b" });
  expect(readdirSync(secretsDir()).filter(name => name.startsWith("credentials.json"))).toEqual(["credentials.json"]);
  if (process.platform !== "win32") expect(statSync(credFile).mode & 0o777).toBe(0o600);
});
