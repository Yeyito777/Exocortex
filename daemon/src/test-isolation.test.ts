import { describe, expect, test } from "bun:test";
import { join, resolve } from "path";
import { configDir, repoRoot } from "@exocortex/shared/paths";

const LIVE_CONFIG_DIR = join(repoRoot(), "config");
const BUN = process.execPath;
const DAEMON_DIR = resolve(import.meta.dir, "..");

function runBunEval(overrides: Record<string, string | undefined>) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }

  return Bun.spawnSync([
    BUN,
    "-e",
    'await import("@exocortex/shared/paths"); console.log("ok");',
  ], {
    cwd: DAEMON_DIR,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("test isolation", () => {
  test("global test preload redirects config away from the live repo config", () => {
    expect(configDir()).not.toBe(LIVE_CONFIG_DIR);
  });

  test("shared paths reject the live config dir during tests without an explicit override", () => {
    const result = runBunEval({
      NODE_ENV: "test",
      EXOCORTEX_TEST: "1",
      EXOCORTEX_CONFIG_DIR: undefined,
      EXOCORTEX_ALLOW_LIVE_CONFIG_IN_TESTS: undefined,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Refusing to use the live Exocortex config directory during tests");
  });

  test("shared paths allow live config during tests only with an explicit override", () => {
    const result = runBunEval({
      NODE_ENV: "test",
      EXOCORTEX_TEST: "1",
      EXOCORTEX_CONFIG_DIR: undefined,
      EXOCORTEX_ALLOW_LIVE_CONFIG_IN_TESTS: "1",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("ok");
  });
});
