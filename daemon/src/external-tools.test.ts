import { describe, expect, test } from "bun:test";
import type { LoadedTool, Manifest } from "./external-tools";
import { buildDaemonSpawnSpec, getExternalToolWatchTargets, getToolReloadKey, rewriteExternalToolShellCommand } from "./external-tools";

function makeTool(overrides: {
  manifest?: Partial<Manifest>;
  binDir?: string;
  toolDir?: string;
} = {}): LoadedTool {
  return {
    manifest: {
      name: "gmail",
      bin: "./bin/gmail",
      systemHint: "hint",
      display: { label: "Gmail", color: "#4ddbb7" },
      ...overrides.manifest,
    },
    binDir: overrides.binDir ?? "/tmp/tools/bin",
    toolDir: overrides.toolDir ?? "/tmp/tools/gmail",
  };
}

describe("buildDaemonSpawnSpec", () => {
  test("returns null for blank commands", () => {
    expect(buildDaemonSpawnSpec("")).toBeNull();
    expect(buildDaemonSpawnSpec("   ")).toBeNull();
  });

  test("executes daemon commands through bash -lc", () => {
    expect(buildDaemonSpawnSpec('python -m app --name "my bot"')).toEqual({
      cmd: "bash",
      args: ["-lc", 'python -m app --name "my bot"'],
    });
  });
});

describe("getToolReloadKey", () => {
  test("same tool metadata produces the same reload key", () => {
    const a = [makeTool()];
    const b = [makeTool()];
    expect(getToolReloadKey(a)).toBe(getToolReloadKey(b));
  });

  test("style changes invalidate the reload key", () => {
    const before = [makeTool()];
    const after = [makeTool({ manifest: { display: { label: "Mail", color: "#ff00ff" } } })];
    expect(getToolReloadKey(before)).not.toBe(getToolReloadKey(after));
  });

  test("shell config changes invalidate the reload key", () => {
    const before = [makeTool({ manifest: { shell: { literalArgs: [{ subcommand: "send", kind: "tail" }] } } })];
    const after = [makeTool({ manifest: { shell: { literalArgs: [{ subcommand: "send", kind: "tail" }, { subcommand: "dm", kind: "flag", flag: "--send" }] } } })];
    expect(getToolReloadKey(before)).not.toBe(getToolReloadKey(after));
  });

  test("daemon config changes invalidate the reload key", () => {
    const before = [makeTool({ manifest: { daemon: { command: "node daemon.js" } } })];
    const after = [makeTool({ manifest: { daemon: { command: "node daemon.js", restart: "always" } } })];
    expect(getToolReloadKey(before)).not.toBe(getToolReloadKey(after));
  });
});

describe("getExternalToolWatchTargets", () => {
  test("watches only the external-tools root and each tool root", () => {
    const tools = [
      makeTool({ manifest: { name: "discord" }, toolDir: "/tmp/external-tools/discord-cli" }),
      makeTool({ manifest: { name: "exo" }, toolDir: "/tmp/external-tools/exo-cli" }),
    ];

    expect(getExternalToolWatchTargets("/tmp/external-tools", tools)).toEqual([
      "/tmp/external-tools",
      "/tmp/external-tools/discord-cli",
      "/tmp/external-tools/exo-cli",
    ]);
  });
});

describe("rewriteExternalToolShellCommand", () => {
  const discord = makeTool({
    manifest: {
      name: "discord",
      bin: "./bin/discord",
      display: { label: "Discord", color: "#5865F2" },
      shell: {
        literalArgs: [
          { subcommand: "send", kind: "tail" },
          { subcommand: "reply", kind: "tail" },
          { subcommand: "edit", kind: "tail" },
          { subcommand: "dm", kind: "flag", flag: "--send" },
        ],
      },
    },
    toolDir: "/tmp/tools/discord",
  });

  test("rewrites the trailing literal argument for configured tail rules", () => {
    const command = 'discord send general "```ts\nconst x = \\\"$HOME\\\"\n```"';
    expect(rewriteExternalToolShellCommand(command, [discord]))
      .toBe("discord send general '```ts\nconst x = \"$HOME\"\n```'");
  });

  test("rewrites flagged literal arguments for configured commands", () => {
    const command = 'discord dm 123 --send "$HOME"';
    expect(rewriteExternalToolShellCommand(command, [discord]))
      .toBe("discord dm 123 --send '$HOME'");
  });

  test("rewrites inline flag assignments for configured commands", () => {
    const command = 'discord dm 123 --send="$HOME"';
    expect(rewriteExternalToolShellCommand(command, [discord]))
      .toBe("discord dm 123 --send='$HOME'");
  });

  test("preserves embedded single quotes in rewritten literals", () => {
    const command = 'discord reply 123 456 "it' + "'" + 's fine"';
    expect(rewriteExternalToolShellCommand(command, [discord]))
      .toBe("discord reply 123 456 'it'\\''s fine'");
  });

  test("supports leading environment assignments", () => {
    const command = 'DEBUG=1 discord dm 123 --send "$USER"';
    expect(rewriteExternalToolShellCommand(command, [discord]))
      .toBe("DEBUG=1 discord dm 123 --send '$USER'");
  });

  test("leaves unsupported complex shell commands alone", () => {
    const command = 'discord dm 123 --send "$HOME" | tee /tmp/out.txt';
    expect(rewriteExternalToolShellCommand(command, [discord])).toBe(command);
  });

  test("leaves unconfigured subcommands alone", () => {
    const command = 'discord react 123 456 👍';
    expect(rewriteExternalToolShellCommand(command, [discord])).toBe(command);
  });

  test("leaves flag rules alone when the flag has no value", () => {
    const command = 'discord dm 123 --send --file note.txt';
    expect(rewriteExternalToolShellCommand(command, [discord])).toBe(command);
  });
});
