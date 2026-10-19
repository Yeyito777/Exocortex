import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCredentialName, loadEnvFile } from "./env";

describe("daemon env file", () => {
  test("exports ordinary settings but never credentials, which every child process would inherit", () => {
    const dir = mkdtempSync(join(tmpdir(), "exo-env-"));
    const path = join(dir, "env");
    writeFileSync(path, [
      "# comment",
      "DISPLAY=:0",
      "export GIT_CONFIG_GLOBAL=\"/home/me/.config/git/.gitconfig\"",
      "GITHUB_KEY=ghp_secret",
      "OPENAI_API_KEY='sk-secret'",
      "SOME_TOKEN=t",
    ].join("\n"));
    const env: NodeJS.ProcessEnv = {};
    try {
      loadEnvFile(path, env);
      expect(env).toEqual({ DISPLAY: ":0", GIT_CONFIG_GLOBAL: "/home/me/.config/git/.gitconfig" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("classifies credential names", () => {
    for (const name of ["GITHUB_KEY", "OPENAI_API_KEY", "GH_TOKEN", "AWS_SECRET_ACCESS_KEY", "DB_PASSWORD", "X_CREDENTIALS"]) {
      expect(isCredentialName(name)).toBe(true);
    }
    for (const name of ["DISPLAY", "GIT_CONFIG_GLOBAL", "PATH", "LANG"]) expect(isCredentialName(name)).toBe(false);
  });
});
