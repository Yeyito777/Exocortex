import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { repoRoot } from "@exocortex/shared/paths";
import { resolveHelperToolPresentation } from "./helper-tool-manifest";

const posixExecutableTest = process.platform === "win32" ? test.skip : test;

async function withProject(run: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "exocortex-helper-tool-"));
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function addHelperTool(root: string, dir: string, name: string, label: string, color: string): void {
  const toolDir = join(root, dir);
  mkdirSync(toolDir, { recursive: true });
  writeFileSync(join(toolDir, name), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(toolDir, "exo-manifest.json"), JSON.stringify({
    version: 1,
    display: { label, color },
  }));
}

describe("helper tool manifests", () => {
  posixExecutableTest("recognizes the bundled computer helper by absolute path", async () => {
    const executable = join(repoRoot(), "helper-tools", "computer", "computer");
    expect(await resolveHelperToolPresentation(`${executable} list-apps`, tmpdir())).toEqual({
      bashStyles: [{ cmd: executable, label: "Computer", color: "#ff79c6" }],
    });
  });

  test("resolves a manifest beside a direct-path helper tool", () => withProject(async (root) => {
    addHelperTool(root, "scripts", "deploy", "Deploy", "#7aa2f7");

    expect(await resolveHelperToolPresentation("./scripts/deploy production", root)).toEqual({
      bashStyles: [{ cmd: "./scripts/deploy", label: "Deploy", color: "#7aa2f7" }],
    });
  }));

  test("does not guess the working directory across shell cd commands", () => withProject(async (root) => {
    addHelperTool(root, ".", "release", "Wrong root", "#ff0000");
    addHelperTool(root, "ops", "release", "Release", "#a6e3a1");

    expect(await resolveHelperToolPresentation("cd ops && ./release stable", root)).toBeUndefined();
    expect(await resolveHelperToolPresentation(">/dev/null cd ops; ./release stable", root)).toBeUndefined();
    expect(await resolveHelperToolPresentation("env --chdir=ops ./release stable", root)).toBeUndefined();
  }));

  test("collects styles for separate helper tools and transparent wrappers", () => withProject(async (root) => {
    addHelperTool(root, "one", "first", "First", "#112233");
    addHelperTool(root, "two", "second", "Second", "#abcdef");

    expect(await resolveHelperToolPresentation(
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
    addHelperTool(root, "scripts with spaces", "check", "Check", "#fedcba");

    expect(await resolveHelperToolPresentation("\"./scripts with spaces/check\" all", root)).toEqual({
      bashStyles: [{ cmd: "\"./scripts with spaces/check\"", label: "Check", color: "#fedcba" }],
    });
  }));

  test("accepts an arbitrary non-empty basename", () => withProject(async (root) => {
    addHelperTool(root, "scripts", "release", "Release", "#a6e3a1");

    expect(await resolveHelperToolPresentation("./scripts/release", root)).toEqual({
      bashStyles: [{ cmd: "./scripts/release", label: "Release", color: "#a6e3a1" }],
    });
  }));

  test("supports attached redirections and here-strings without scanning heredoc bodies", () => withProject(async (root) => {
    addHelperTool(root, "scripts", "check", "Check", "#fedcba");

    expect(await resolveHelperToolPresentation("./scripts/check>result.txt", root)).toEqual({
      bashStyles: [{ cmd: "./scripts/check", label: "Check", color: "#fedcba" }],
    });
    expect(await resolveHelperToolPresentation("./scripts/check <<< input", root)).toEqual({
      bashStyles: [{ cmd: "./scripts/check", label: "Check", color: "#fedcba" }],
    });
  }));

  test("ignores PATH commands, interpreter arguments, and expansions", () => withProject(async (root) => {
    addHelperTool(root, "scripts", "deploy", "Deploy", "#7aa2f7");

    expect(await resolveHelperToolPresentation("deploy production", join(root, "scripts"))).toBeUndefined();
    expect(await resolveHelperToolPresentation("bash ./scripts/deploy production", root)).toBeUndefined();
    expect(await resolveHelperToolPresentation("$ROOT/scripts/deploy production", root)).toBeUndefined();
  }));

  test("never treats a command-looking heredoc body as an invocation", () => withProject(async (root) => {
    addHelperTool(root, "scripts", "deploy", "Deploy", "#7aa2f7");
    const command = [
      "cat <<'EOF'",
      "./scripts/deploy production",
      "EOF",
    ].join("\n");

    expect(await resolveHelperToolPresentation(command, root)).toBeUndefined();
  }));

  test("invalid or missing manifests fall back without throwing", () => withProject(async (root) => {
    const scripts = join(root, "scripts");
    mkdirSync(scripts);
    writeFileSync(join(scripts, "broken"), "#!/bin/sh\n", { mode: 0o755 });

    expect(await resolveHelperToolPresentation("./scripts/broken", root)).toBeUndefined();

    writeFileSync(join(scripts, "exo-manifest.json"), JSON.stringify({
      version: 2,
      display: { label: "Broken", color: "blue" },
    }));
    expect(await resolveHelperToolPresentation("./scripts/broken", root)).toBeUndefined();

    writeFileSync(join(scripts, "exo-manifest.json"), "not json");
    expect(await resolveHelperToolPresentation("./scripts/broken", root)).toBeUndefined();
  }));
});
