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

describe("sidecar command manifests", () => {
  test("resolves a manifest beside a direct-path exo command", () => withProject(async (root) => {
    addCommand(root, "scripts", "exo-deploy", "Deploy", "#7aa2f7");

    expect(await resolveExoCommandPresentation("./scripts/exo-deploy production", root)).toEqual({
      bashStyles: [{ cmd: "./scripts/exo-deploy", label: "Deploy", color: "#7aa2f7" }],
    });
  }));

  test("does not guess the working directory across shell cd commands", () => withProject(async (root) => {
    addCommand(root, ".", "exo-release", "Wrong root", "#ff0000");
    addCommand(root, "ops", "exo-release", "Release", "#a6e3a1");

    expect(await resolveExoCommandPresentation("cd ops && ./exo-release stable", root)).toBeUndefined();
    expect(await resolveExoCommandPresentation(">/dev/null cd ops; ./exo-release stable", root)).toBeUndefined();
    expect(await resolveExoCommandPresentation("env --chdir=ops ./exo-release stable", root)).toBeUndefined();
  }));

  test("collects styles for separate commands and transparent wrappers", () => withProject(async (root) => {
    addCommand(root, "one", "exo-first", "First", "#112233");
    addCommand(root, "two", "exo-second", "Second", "#abcdef");

    expect(await resolveExoCommandPresentation(
      "./one/exo-first go && env MODE=ci command ./two/exo-second now > output.txt",
      root,
    )).toEqual({
      bashStyles: [
        { cmd: "./one/exo-first", label: "First", color: "#112233" },
        { cmd: "./two/exo-second", label: "Second", color: "#abcdef" },
      ],
    });
  }));

  test("keeps the raw quoted executable token for deterministic TUI matching", () => withProject(async (root) => {
    addCommand(root, "scripts with spaces", "exo-check", "Check", "#fedcba");

    expect(await resolveExoCommandPresentation("\"./scripts with spaces/exo-check\" all", root)).toEqual({
      bashStyles: [{ cmd: "\"./scripts with spaces/exo-check\"", label: "Check", color: "#fedcba" }],
    });
  }));

  test("accepts any non-empty exo- basename suffix", () => withProject(async (root) => {
    addCommand(root, "scripts", "exo--release", "Release", "#a6e3a1");

    expect(await resolveExoCommandPresentation("./scripts/exo--release", root)).toEqual({
      bashStyles: [{ cmd: "./scripts/exo--release", label: "Release", color: "#a6e3a1" }],
    });
  }));

  test("supports attached redirections and here-strings without scanning heredoc bodies", () => withProject(async (root) => {
    addCommand(root, "scripts", "exo-check", "Check", "#fedcba");

    expect(await resolveExoCommandPresentation("./scripts/exo-check>result.txt", root)).toEqual({
      bashStyles: [{ cmd: "./scripts/exo-check", label: "Check", color: "#fedcba" }],
    });
    expect(await resolveExoCommandPresentation("./scripts/exo-check <<< input", root)).toEqual({
      bashStyles: [{ cmd: "./scripts/exo-check", label: "Check", color: "#fedcba" }],
    });
  }));

  test("ignores PATH commands, interpreter arguments, expansions, and non-exo basenames", () => withProject(async (root) => {
    addCommand(root, "scripts", "exo-deploy", "Deploy", "#7aa2f7");
    writeFileSync(join(root, "scripts", "ordinary"), "#!/bin/sh\n", { mode: 0o755 });

    expect(await resolveExoCommandPresentation("exo-deploy production", join(root, "scripts"))).toBeUndefined();
    expect(await resolveExoCommandPresentation("bash ./scripts/exo-deploy production", root)).toBeUndefined();
    expect(await resolveExoCommandPresentation("$ROOT/scripts/exo-deploy production", root)).toBeUndefined();
    expect(await resolveExoCommandPresentation("./scripts/ordinary", root)).toBeUndefined();
  }));

  test("never treats a command-looking heredoc body as an invocation", () => withProject(async (root) => {
    addCommand(root, "scripts", "exo-deploy", "Deploy", "#7aa2f7");
    const command = [
      "cat <<'EOF'",
      "./scripts/exo-deploy production",
      "EOF",
    ].join("\n");

    expect(await resolveExoCommandPresentation(command, root)).toBeUndefined();
  }));

  test("invalid or missing manifests fall back without throwing", () => withProject(async (root) => {
    const scripts = join(root, "scripts");
    mkdirSync(scripts);
    writeFileSync(join(scripts, "exo-broken"), "#!/bin/sh\n", { mode: 0o755 });

    expect(await resolveExoCommandPresentation("./scripts/exo-broken", root)).toBeUndefined();

    writeFileSync(join(scripts, "exo-manifest.json"), JSON.stringify({
      version: 2,
      display: { label: "Broken", color: "blue" },
    }));
    expect(await resolveExoCommandPresentation("./scripts/exo-broken", root)).toBeUndefined();

    writeFileSync(join(scripts, "exo-manifest.json"), "not json");
    expect(await resolveExoCommandPresentation("./scripts/exo-broken", root)).toBeUndefined();
  }));
});
