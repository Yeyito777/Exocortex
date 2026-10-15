import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveHelperToolPresentation } from "./helper-tool-manifest";

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

  test("a full tool manifest styles only the executable its bin names", () => withProject(async (root) => {
    const toolDir = join(root, "mail-cli");
    mkdirSync(join(toolDir, "bin"), { recursive: true });
    writeFileSync(join(toolDir, "bin", "mail"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(toolDir, "bin", "other"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(toolDir, "manifest.json"), JSON.stringify({
      name: "mail", bin: "./bin/mail", systemHint: "", display: { label: "Mail", color: "#4ddbb7" },
    }));

    expect(await resolveHelperToolPresentation(`${toolDir}/bin/mail read 1`, root)).toEqual({
      bashStyles: [{ cmd: `${toolDir}/bin/mail`, label: "Mail", color: "#4ddbb7" }],
    });
    expect(await resolveHelperToolPresentation(`${toolDir}/bin/other`, root)).toBeUndefined();
  }));

  test("follows an absolute cd only while its && chain holds", () => withProject(async (root) => {
    addHelperTool(root, "ops", "release", "Release", "#a6e3a1");
    const release = { bashStyles: [{ cmd: "./release", label: "Release", color: "#a6e3a1" }] };
    const ops = join(root, "ops");

    expect(await resolveHelperToolPresentation(`cd ${ops} && ./release stable`, "/")).toEqual(release);
    expect(await resolveHelperToolPresentation(`cd ${ops} && ./release stable | tee log`, "/")).toEqual(release);
    expect(await resolveHelperToolPresentation(`cd ${ops} && for x in a; do ./release $x; done`, "/")).toEqual(release);
    expect(await resolveHelperToolPresentation(`cd ${ops}; ./release stable`, "/")).toBeUndefined();
    expect(await resolveHelperToolPresentation(`cd ${ops} && true; ./release stable`, "/")).toBeUndefined();
    expect(await resolveHelperToolPresentation(`cd ${ops} && true || ./release stable`, "/")).toBeUndefined();
  }));

  test("resolves variables that hold one static tool path", () => withProject(async (root) => {
    addHelperTool(root, "scripts", "deploy", "Deploy", "#7aa2f7");
    const deploy = join(root, "scripts", "deploy");

    expect(await resolveHelperToolPresentation(`T=${deploy}; "$T" production`, root)).toEqual({
      bashStyles: [{ cmd: "\"$T\"", label: "Deploy", color: "#7aa2f7" }],
    });
    expect(await resolveHelperToolPresentation(`export T=${deploy}\n\${T} production`, root)).toEqual({
      bashStyles: [{ cmd: "${T}", label: "Deploy", color: "#7aa2f7" }],
    });
    expect(await resolveHelperToolPresentation(`T=$(command -v deploy 2>/dev/null || echo ${deploy}); $T x`, root)).toEqual({
      bashStyles: [{ cmd: "$T", label: "Deploy", color: "#7aa2f7" }],
    });
    // The fallback must name the tool command -v looks for.
    expect(await resolveHelperToolPresentation(`T=$(command -v other || echo ${deploy}); $T x`, root)).toBeUndefined();
    expect(await resolveHelperToolPresentation(`T=$(dirname ${deploy})/deploy; $T x`, root)).toBeUndefined();
    expect(await resolveHelperToolPresentation("T=$X; $T production", root)).toBeUndefined();
  }));

  test("styles the tool that reads a heredoc, never its body", () => withProject(async (root) => {
    addHelperTool(root, "scripts", "deploy", "Deploy", "#7aa2f7");
    const style = { bashStyles: [{ cmd: "./scripts/deploy", label: "Deploy", color: "#7aa2f7" }] };

    expect(await resolveHelperToolPresentation("./scripts/deploy <<'EOF'\nbody\nEOF", root)).toEqual(style);
    expect(await resolveHelperToolPresentation("cat <<-EOF\n\t./scripts/deploy\n\tEOF\n./scripts/deploy now", root)).toEqual(style);
    // An unterminated heredoc styles nothing rather than guess.
    expect(await resolveHelperToolPresentation("./scripts/deploy <<EOF\nbody", root)).toBeUndefined();
  }));
});

