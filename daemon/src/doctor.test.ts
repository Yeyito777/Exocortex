import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { createServer, type Server } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { clientSocketPath, diagnose, findClaudeBinary, linksInto, probeDaemon, readClaudeLogin, type DoctorReport } from "./doctor";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "exo-doctor-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function report(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return {
    schema: 1,
    ok: true,
    platform: "linux",
    exocortex: { repoDir: "/repo", version: "0.1.0", commit: "abc", branch: "main", dependencies: true },
    bun: { path: "/bin/bun", version: "1.3.0" },
    claudeCode: { found: true, path: "/bin/claude", version: "2.0.0", loggedIn: true, email: "me@example.com" },
    daemon: { socket: "/s", running: true, responsive: true, pid: 1, service: { manager: "systemd", name: "x", installed: true, active: true } },
    providers: { anthropic: { authenticated: true, status: "logged_in", email: "me@example.com", source: "claude-code" } },
    commands: { exocortexd: "/home/me/.local/bin/exocortexd", tui: null },
    problems: [],
    ...overrides,
  };
}

describe("diagnose", () => {
  test("a working install has no problems", () => {
    expect(diagnose(report())).toEqual([]);
  });

  test("a stopped daemon and no sign-in are errors with fixes", () => {
    const problems = diagnose(report({
      daemon: { socket: "/s", running: false, responsive: false, pid: null, service: { manager: "systemd", name: "x", installed: true, active: false } },
      providers: { opencode: { authenticated: true, status: "logged_in", email: null, source: "public" } },
    }));
    expect(problems.map(p => [p.id, p.severity])).toEqual([["daemon-not-running", "error"], ["no-provider-login", "error"]]);
    expect(problems[0].fix).toBe("exocortexd start");
  });

  test("Claude Code missing is only a warning when another provider is signed in", () => {
    const problems = diagnose(report({
      claudeCode: { found: false, path: null, version: null, loggedIn: null, email: null },
      providers: { openai: { authenticated: true, status: "logged_in", email: null, source: "oauth" } },
    }));
    expect(problems.map(p => [p.id, p.severity])).toEqual([["claude-code-missing", "warning"]]);
  });

  test("missing dependencies skip the provider check", () => {
    const problems = diagnose(report({ exocortex: { ...report().exocortex, dependencies: false }, providers: null }));
    expect(problems.map(p => p.id)).toEqual(["dependencies-missing"]);
  });
});

describe("readClaudeLogin", () => {
  test("reads the account from .claude.json and requires credentials on Linux", () => {
    const home = tempDir();
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "me@example.com" } }));
    expect(readClaudeLogin({}, home, "linux")).toEqual({ loggedIn: false, email: null });
    expect(readClaudeLogin({}, home, "darwin")).toEqual({ loggedIn: true, email: "me@example.com" });
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
    expect(readClaudeLogin({}, home, "linux")).toEqual({ loggedIn: true, email: "me@example.com" });
  });

  test("honors CLAUDE_CONFIG_DIR and treats a missing config as signed out", () => {
    const home = tempDir();
    const configDir = join(home, "alt");
    mkdirSync(configDir);
    expect(readClaudeLogin({ CLAUDE_CONFIG_DIR: configDir }, home, "linux")).toEqual({ loggedIn: false, email: null });
    writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "alt@example.com" } }));
    writeFileSync(join(configDir, ".credentials.json"), "{}");
    expect(readClaudeLogin({ CLAUDE_CONFIG_DIR: configDir }, home, "linux")).toEqual({ loggedIn: true, email: "alt@example.com" });
  });
});

describe("findClaudeBinary", () => {
  test("falls back to the native installer's location off PATH", () => {
    const home = tempDir();
    expect(findClaudeBinary({ PATH: "" }, home)).toBeNull();
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    const claude = join(home, ".local", "bin", "claude");
    writeFileSync(claude, "#!/bin/sh\n");
    chmodSync(claude, 0o755);
    expect(findClaudeBinary({ PATH: "" }, home)).toBe(claude);
  });
});

describe("linksInto", () => {
  test("only a link into this checkout counts", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "repo", "bin"), { recursive: true });
    writeFileSync(join(dir, "repo", "bin", "exocortex"), "");
    symlinkSync(join(dir, "repo", "bin", "exocortex"), join(dir, "link"));
    expect(linksInto(join(dir, "link"), join(dir, "repo"))).toBe(true);
    expect(linksInto(join(dir, "link"), join(dir, "other"))).toBe(false);
    expect(linksInto(join(dir, "missing"), join(dir, "repo"))).toBe(false);
  });
});

describe("clientSocketPath", () => {
  test("EXOCORTEX_SOCKET wins", () => {
    expect(clientSocketPath({ EXOCORTEX_SOCKET: "/tmp/x.sock" })).toBe("/tmp/x.sock");
    expect(clientSocketPath({})).toEndWith(".sock");
  });
});

describe("probeDaemon", () => {
  let server: Server | null = null;
  afterEach(() => { server?.close(); server = null; });

  test("a missing socket is not running", async () => {
    expect(await probeDaemon(join(tempDir(), "none.sock"))).toEqual({ running: false, responsive: false });
  });

  test("answers from a pong to its light ping", async () => {
    const socket = join(tempDir(), "d.sock");
    const seen: unknown[] = [];
    server = createServer((conn) => {
      conn.on("data", (chunk) => {
        const command = JSON.parse(chunk.toString().trim());
        seen.push(command);
        conn.write(`${JSON.stringify({ type: "update_status" })}\n${JSON.stringify({ type: "pong", reqId: command.reqId })}\n`);
      });
    });
    await new Promise<void>(resolve => server!.listen(socket, resolve));
    expect(await probeDaemon(socket)).toEqual({ running: true, responsive: true });
    expect(seen).toEqual([{ type: "ping", reqId: "doctor", updateStatusOnly: true }]);
  });

  test("a silent daemon is running but not responsive", async () => {
    const socket = join(tempDir(), "d.sock");
    server = createServer(() => {});
    await new Promise<void>(resolve => server!.listen(socket, resolve));
    expect(await probeDaemon(socket, 200)).toEqual({ running: true, responsive: false });
  });
});
