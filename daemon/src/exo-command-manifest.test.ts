import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveExoCommandPresentation } from "./exo-command-manifest";

async function withProject(run: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "exocortex-exo-command-"));
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function addCommand(root: string, dir: string, name: string, label: string, color: string): void {
  const commandDir = join(root, dir);
  mkdirSync(commandDir, { recursive: true });
  writeFileSync(join(commandDir, name), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(commandDir, "exo-manifest.json"), JSON.stringify({
    version: 1,
    display: { label, color },
  }));
}

describe("helper command manifests", () => {
  test("resolves a manifest beside a direct-path helper command", () => withProject(async (root) => {
    addCommand(root, "scripts", "deploy", "Deploy", "#7aa2f7");

    expect(await resolveExoCommandPresentation("./scripts/deploy production", root)).toEqual({
      bashStyles: [{ cmd: "./scripts/deploy", label: "Deploy", color: "#7aa2f7" }],
    });
  }));

  test("does not guess the working directory across shell cd commands", () => withProject(async (root) => {
    addCommand(root, ".", "release", "Wrong root", "#ff0000");
    addCommand(root, "ops", "release", "Release", "#a6e3a1");

    expect(await resolveExoCommandPresentation("cd ops && ./release stable", root)).toBeUndefined();
    expect(await resolveExoCommandPresentation(">/dev/null cd ops; ./release stable", root)).toBeUndefined();
    expect(await resolveExoCommandPresentation("env --chdir=ops ./release stable", root)).toBeUndefined();
  }));

  test("collects styles for separate commands and transparent wrappers", () => withProject(async (root) => {
    addCommand(root, "one", "first", "First", "#112233");
    addCommand(root, "two", "second", "Second", "#abcdef");

    expect(await resolveExoCommandPresentation(
      "./one/first go && env MODE=ci command ./two/second now > output.txt",
      root,
    )).toEqual({
      bashStyles: [
        { cmd: "./one/first", label: "First", color: "#112233" },
        { cmd: "./two/second", label: "Second", color: "#abcdef" },
      ],
    });
  }));

  test("keeps the raw quoted executable token for deterministic TUI matching", () => withProject(async (root) => {
    addCommand(root, "scripts with spaces", "check", "Check", "#fedcba");

    expect(await resolveExoCommandPresentation("\"./scripts with spaces/check\" all", root)).toEqual({
      bashStyles: [{ cmd: "\"./scripts with spaces/check\"", label: "Check", color: "#fedcba" }],
    });
  }));

  test("accepts an arbitrary non-empty basename", () => withProject(async (root) => {
    addCommand(root, "scripts", "release", "Release", "#a6e3a1");

    expect(await resolveExoCommandPresentation("./scripts/release", root)).toEqual({
      bashStyles: [{ cmd: "./scripts/release", label: "Release", color: "#a6e3a1" }],
    });
  }));

  test("supports attached redirections and here-strings without scanning heredoc bodies", () => withProject(async (root) => {
    addCommand(root, "scripts", "check", "Check", "#fedcba");

    expect(await resolveExoCommandPresentation("./scripts/check>result.txt", root)).toEqual({
      bashStyles: [{ cmd: "./scripts/check", label: "Check", color: "#fedcba" }],
    });
    expect(await resolveExoCommandPresentation("./scripts/check <<< input", root)).toEqual({
      bashStyles: [{ cmd: "./scripts/check", label: "Check", color: "#fedcba" }],
    });
  }));

  test("ignores PATH commands, interpreter arguments, and expansions", () => withProject(async (root) => {
    addCommand(root, "scripts", "deploy", "Deploy", "#7aa2f7");

    expect(await resolveExoCommandPresentation("deploy production", join(root, "scripts"))).toBeUndefined();
    expect(await resolveExoCommandPresentation("bash ./scripts/deploy production", root)).toBeUndefined();
    expect(await resolveExoCommandPresentation("$ROOT/scripts/deploy production", root)).toBeUndefined();
  }));

  test("never treats a command-looking heredoc body as an invocation", () => withProject(async (root) => {
    addCommand(root, "scripts", "deploy", "Deploy", "#7aa2f7");
    const command = [
      "cat <<'EOF'",
      "./scripts/deploy production",
      "EOF",
    ].join("\n");

    expect(await resolveExoCommandPresentation(command, root)).toBeUndefined();
  }));

  test("invalid or missing manifests fall back without throwing", () => withProject(async (root) => {
    const scripts = join(root, "scripts");
    mkdirSync(scripts);
    writeFileSync(join(scripts, "broken"), "#!/bin/sh\n", { mode: 0o755 });

    expect(await resolveExoCommandPresentation("./scripts/broken", root)).toBeUndefined();

    writeFileSync(join(scripts, "exo-manifest.json"), JSON.stringify({
      version: 2,
      display: { label: "Broken", color: "blue" },
    }));
    expect(await resolveExoCommandPresentation("./scripts/broken", root)).toBeUndefined();

    writeFileSync(join(scripts, "exo-manifest.json"), "not json");
    expect(await resolveExoCommandPresentation("./scripts/broken", root)).toBeUndefined();
  }));
});
