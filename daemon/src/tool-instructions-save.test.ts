import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { repoRoot } from "@exocortex/shared/paths";
import { setLoadedExternalToolsForTest, type LoadedTool } from "./external-tools";
import { describeToolInstructions } from "./tool-instructions";
import { findTopLevelString, normalizeToolText, replaceManifestSystemHint, saveToolInstructions } from "./tool-instructions-save";
import { exo } from "./tools/exo";
import { goal } from "./tools/goal";
import { attach } from "./tools/attach";
import { setToolTextDirForTest, toolTextDir } from "./tools/tool-text";
import { retemplate } from "./tools/tool-text-template";

const ROUTE = { provider: "openai" as const, model: "gpt-6.1-sol" };

function run(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A checkout with a bare remote, like whale's: `dir` holds `files` under `sub`. */
function scratchRepo(root: string, name: string, files: (dir: string) => void): { repo: string; remote: string } {
  const remote = join(root, `${name}.git`);
  const repo = join(root, name);
  run(root, "init", "--quiet", "--bare", "-b", "main", remote);
  run(root, "clone", "--quiet", remote, repo);
  run(repo, "config", "user.name", "Test");
  run(repo, "config", "user.email", "test@example.com");
  run(repo, "checkout", "--quiet", "-b", "main");
  files(repo);
  run(repo, "add", "-A");
  run(repo, "commit", "--quiet", "-m", "initial");
  run(repo, "push", "--quiet", "-u", "origin", "main");
  return { repo, remote };
}

function block(id: string): { text: string } {
  const view = describeToolInstructions(ROUTE.provider, ROUTE.model);
  const found = [...view.internal, ...view.external].flatMap(entry => entry.blocks ?? []).find(candidate => candidate.id === id);
  if (!found) throw new Error(`no block ${id}`);
  return found;
}

let root: string;
let restoreDir: () => void = () => {};
let restoreTools: () => void = () => {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tool-text-save-"));
});

afterEach(() => {
  restoreDir();
  restoreTools();
  restoreDir = () => {};
  restoreTools = () => {};
  rmSync(root, { recursive: true, force: true });
});

function useInternalScratch(): { repo: string; remote: string; text: string } {
  const source = toolTextDir();
  const scratch = scratchRepo(root, "exocortex", repo => cpSync(source, join(repo, "text"), { recursive: true }));
  restoreDir = setToolTextDirForTest(join(scratch.repo, "text"));
  return { ...scratch, text: join(scratch.repo, "text") };
}

describe("save_tool_instructions", () => {
  test("an internal hint: written with its placeholders kept, committed, pushed, and live at once", async () => {
    const { repo, remote, text } = useInternalScratch();
    const before = block("internal:exo:hint").text;
    expect(before).toContain(`${repoRoot()}/docs/daemon-ipc.md`);
    const edited = before.replace("Do the user's task yourself by default", "Do the task yourself unless told otherwise");

    const result = await saveToolInstructions(ROUTE, [{ id: "internal:exo:hint", text: `${edited}\n\n`, expected: before }]);

    const file = readFileSync(join(text, "exo.hint.md"), "utf-8");
    expect(file).toStartWith("Do the task yourself unless told otherwise");
    expect(file).toContain("read {{repoRoot}}/docs/daemon-ipc.md and {{repoRoot}}/shared/src/protocol.ts first.\n");
    expect(file.endsWith("first.\n")).toBe(true);
    expect(exo.systemHint).toBe(edited);
    expect(result.saved).toEqual([{ id: "internal:exo:hint", text: edited }]);
    expect(result.commits).toHaveLength(1);
    const [commit] = result.commits;
    expect(commit).toMatchObject({ pushed: true });
    expect(commit.error).toBeUndefined();
    expect(run(remote, "log", "-1", "--format=%s")).toBe("instructions: edit exo hint via /instructions tools");
    expect(run(remote, "rev-parse", "--short", "main")).toBe(commit.commit!);
    expect(run(repo, "show", "--stat", "--format=", "HEAD")).toContain("text/exo.hint.md");
  });

  test("a tool without a hint gets one; clearing it leaves an empty file and no hint", async () => {
    const { text } = useInternalScratch();
    expect(attach.systemHint).toBeUndefined();
    await saveToolInstructions(ROUTE, [{ id: "internal:attach:hint", text: "Attach charts you render.", expected: "" }]);
    expect(readFileSync(join(text, "attach.hint.md"), "utf-8")).toBe("Attach charts you render.\n");
    expect(attach.systemHint).toBe("Attach charts you render.");

    await saveToolInstructions(ROUTE, [{ id: "internal:goal:hint", text: "  \n", expected: block("internal:goal:hint").text }]);
    expect(readFileSync(join(text, "goal.hint.md"), "utf-8")).toBe("");
    expect(goal.systemHint).toBeUndefined();
  });

  test("refused saves write nothing: a changed block, an empty description, an unknown id, malformed edits", async () => {
    const { repo, text } = useInternalScratch();
    const head = run(repo, "rev-parse", "HEAD");
    const hint = block("internal:goal:hint").text;
    await expect(saveToolInstructions(ROUTE, [
      { id: "internal:browse:hint", text: "new browse hint", expected: block("internal:browse:hint").text },
      { id: "internal:goal:hint", text: "x", expected: "stale" },
    ])).rejects.toThrow("The goal hint changed since you opened it; :w! overwrites");
    await expect(saveToolInstructions(ROUTE, [{ id: "internal:goal:description", text: " ", expected: block("internal:goal:description").text }]))
      .rejects.toThrow("The goal description can't be empty");
    await expect(saveToolInstructions(ROUTE, [{ id: "internal:nope:hint", text: "x", expected: "" }])).rejects.toThrow("not tool text on this route");
    await expect(saveToolInstructions(ROUTE, [{ id: "internal:goal:hint", text: 3, expected: hint }])).rejects.toThrow("Malformed edit");
    await expect(saveToolInstructions(ROUTE, [])).rejects.toThrow("Nothing to save");
    await expect(saveToolInstructions(ROUTE, [{ id: "internal:goal:hint", text: "a\u0000b", expected: hint }])).rejects.toThrow("control characters");
    expect(readFileSync(join(text, "browse.hint.md"), "utf-8")).not.toContain("new browse hint");
    expect(run(repo, "rev-parse", "HEAD")).toBe(head);
    expect(run(repo, "status", "--porcelain")).toBe("");

    // :w! overwrites a block that changed meanwhile.
    const forced = await saveToolInstructions(ROUTE, [{ id: "internal:goal:hint", text: "forced", expected: "stale" }], true);
    expect(forced.commits[0].pushed).toBe(true);
    expect(readFileSync(join(text, "goal.hint.md"), "utf-8")).toBe("forced\n");
  });

  test("commits only its own paths, pulls when the remote moved, and keeps others' staged work staged", async () => {
    const { repo, remote } = useInternalScratch();
    // Another clone pushes first; another agent has staged work in this checkout.
    const other = join(root, "other");
    run(root, "clone", "--quiet", remote, other);
    run(other, "config", "user.name", "Other");
    run(other, "config", "user.email", "other@example.com");
    writeFileSync(join(other, "NOTES.md"), "from elsewhere\n");
    run(other, "add", "NOTES.md");
    run(other, "commit", "--quiet", "-m", "elsewhere");
    run(other, "push", "--quiet");
    writeFileSync(join(repo, "STAGED.md"), "someone else's\n");
    run(repo, "add", "STAGED.md");
    writeFileSync(join(repo, "text", "chrono.hint.md"), "unstaged edit by someone else\n");

    const result = await saveToolInstructions(ROUTE, [{ id: "internal:browse:hint", text: "Prefer browse.", expected: block("internal:browse:hint").text }]);

    expect(result.commits[0]).toMatchObject({ pushed: true });
    expect(run(remote, "log", "--format=%s", "-3").split("\n")).toEqual(["instructions: edit browse hint via /instructions tools", "elsewhere", "initial"]);
    expect(run(remote, "show", "--name-only", "--format=", "main")).toBe("text/browse.hint.md");
    expect(run(repo, "diff", "--cached", "--name-only")).toBe("STAGED.md");
    expect(readFileSync(join(repo, "text", "chrono.hint.md"), "utf-8")).toBe("unstaged edit by someone else\n");
    expect(existsSync(join(repo, "NOTES.md"))).toBe(true);
  });

  test("a failed push keeps the local commit and says why", async () => {
    const { repo } = useInternalScratch();
    run(repo, "remote", "set-url", "origin", join(root, "missing.git"));
    const result = await saveToolInstructions(ROUTE, [{ id: "internal:browse:hint", text: "Prefer browse.", expected: block("internal:browse:hint").text }]);
    const [commit] = result.commits;
    expect(commit.pushed).toBe(false);
    expect(commit.commit).toBe(run(repo, "rev-parse", "--short", "HEAD"));
    expect(commit.error).toStartWith("git fetch failed:");
    expect(run(repo, "log", "-1", "--format=%s")).toBe("instructions: edit browse hint via /instructions tools");
  });

  test("an external hint: only the manifest's systemHint changes, placeholders kept, committed in the tool's repo", async () => {
    restoreDir = setToolTextDirForTest(toolTextDir());
    const manifest = (hint: string) => `{\n  "name": "demo",\n  "bin": "./bin/demo",\n    "systemHint": ${JSON.stringify(hint)},\n  "display": { "label": "Demo", "color": "#ffffff" },\n  "nested": { "systemHint": "not this one" }\n}\n`;
    const raw = manifest("Run `demo -h` (source at <exocortex-source-dir>/external-tools/demo-cli).");
    const { repo, remote } = scratchRepo(root, "demo-cli", dir => {
      mkdirSync(join(dir, "bin"));
      writeFileSync(join(dir, "bin", "demo"), "#!/bin/sh\n");
      writeFileSync(join(dir, "manifest.json"), raw);
    });
    const tool: LoadedTool = { manifest: JSON.parse(raw), binDir: join(repo, "bin"), toolDir: repo };
    restoreTools = setLoadedExternalToolsForTest([tool]);
    const before = block("external:demo").text;
    expect(before).toBe(`Run \`demo -h\` (source at ${repoRoot()}/external-tools/demo-cli).`);

    const result = await saveToolInstructions(ROUTE, [{ id: "external:demo", text: before.replace("Run", "Always run"), expected: before }]);

    expect(readFileSync(join(repo, "manifest.json"), "utf-8")).toBe(manifest("Always run `demo -h` (source at <exocortex-source-dir>/external-tools/demo-cli)."));
    expect(result.commits).toEqual([{ repo, commit: run(repo, "rev-parse", "--short", "HEAD"), pushed: true }]);
    expect(run(remote, "log", "-1", "--format=%s")).toBe("instructions: edit demo hint via /instructions tools");
  });

  test("a broken manifest is never rewritten", async () => {
    const dir = join(root, "broken");
    mkdirSync(dir);
    writeFileSync(join(dir, "manifest.json"), "{ \"name\": \"demo\", \"systemHint\": \"x\", }");
    restoreTools = setLoadedExternalToolsForTest([{ manifest: { name: "demo", bin: "demo", systemHint: "x", display: { label: "D", color: "#fff" } }, binDir: dir, toolDir: dir }]);
    await expect(saveToolInstructions(ROUTE, [{ id: "external:demo", text: "y", expected: "x" }])).rejects.toThrow("is not valid JSON");
    expect(readFileSync(join(dir, "manifest.json"), "utf-8")).toBe("{ \"name\": \"demo\", \"systemHint\": \"x\", }");
  });
});

describe("retemplate", () => {
  const tokens = [["{{repoRoot}}", "/home/u/exo"], ["{{shell}}", "bash"], ["{{alias}}", ""]] as const;

  test("keeps placeholders whose expansion survived, literal text where it changed", () => {
    const template = "Run {{shell}} here; read {{repoRoot}}/docs and {{repoRoot}}/shared.";
    const expanded = "Run bash here; read /home/u/exo/docs and /home/u/exo/shared.";
    expect(retemplate(template, tokens, expanded, "Always run bash here; read /home/u/exo/docs and /home/u/exo/shared too."))
      .toBe("Always run {{shell}} here; read {{repoRoot}}/docs and {{repoRoot}}/shared too.");
    // An edit inside an expansion makes it literal.
    expect(retemplate(template, tokens, expanded, "Run zsh here; read /home/u/exo/docs and /home/u/eXo/shared."))
      .toBe("Run zsh here; read {{repoRoot}}/docs and /home/u/eXo/shared.");
    // Text the user types that happens to equal a value stays literal.
    expect(retemplate("Use {{shell}}.", tokens, "Use bash.", "Use bash. Not bash.")).toBe("Use {{shell}}. Not bash.");
    expect(retemplate("Use {{shell}}.", tokens, "Use bash.", "")).toBe("");
  });

  test("an empty placeholder stays where its neighbours still meet", () => {
    expect(retemplate("on {{alias}}the machine", tokens, "on the machine", "Run on the machine")).toBe("Run on {{alias}}the machine");
    expect(retemplate("on {{alias}}the machine", tokens, "on the machine", "on the box")).toBe("on {{alias}}the box");
  });

  test("a template that does not expand to the shown text is replaced as typed", () => {
    expect(retemplate("{{shell}}", tokens, "zsh", "fish")).toBe("fish");
  });

  test("long rewrites still keep untouched ends", () => {
    const template = `${"a".repeat(3000)} {{repoRoot}} ${"b".repeat(10)}`;
    const expanded = `${"a".repeat(3000)} /home/u/exo ${"b".repeat(10)}`;
    const edited = `${"c".repeat(3000)} /home/u/exo ${"b".repeat(10)}`;
    expect(retemplate(template, tokens, expanded, edited)).toBe(`${"c".repeat(3000)} {{repoRoot}} ${"b".repeat(10)}`);
  });
});

describe("manifest rewriting", () => {
  test("finds only the top-level key and keeps every other byte", () => {
    const raw = `{"display":{"systemHint":"inner"},"systemHint" : "a \\" b","x":1}`;
    const span = findTopLevelString(raw, "systemHint")!;
    expect(raw.slice(span.start, span.end)).toBe(`"a \\" b"`);
    expect(replaceManifestSystemHint(raw, "new\nline", "m.json")).toBe(`{"display":{"systemHint":"inner"},"systemHint" : "new\\nline","x":1}`);
    expect(() => replaceManifestSystemHint(`{"systemHint": 3}`, "x", "m.json")).toThrow("no string systemHint");
  });

  test("normalizes what is stored", () => {
    expect(normalizeToolText("\n\n  first\r\nsecond  \n\n")).toBe("  first\nsecond");
    expect(normalizeToolText(" \n\t\n")).toBe("");
  });
});
