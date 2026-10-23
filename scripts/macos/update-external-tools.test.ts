import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SCRIPT = join(import.meta.dir, "update-external-tools.sh");
const root = mkdtempSync(join(tmpdir(), "update-tools-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

function commit(dir: string, file: string, content: string): void {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), content);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `edit ${file}`);
}

let counter = 0;
/** A tool clone under `tools/` tracking a bare origin; `pusher` is a second clone used to publish new commits. */
function makeTool(tools: string, name: string) {
  const id = `${name}-${counter++}`;
  const origin = join(root, `${id}.git`);
  const seed = join(root, `${id}-seed`);
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, seed);
  git(seed, "checkout", "-q", "-b", "main");
  writeFileSync(join(seed, ".gitignore"), ".venv/\npip.args\n");
  commit(seed, "README.md", "one\n");
  git(seed, "push", "-q", "-u", "origin", "main");
  const dir = join(tools, name);
  git(root, "clone", "-q", origin, dir);
  return { dir, seed, origin, publish: (f: string, c: string) => { commit(seed, f, c); git(seed, "push", "-q", "origin", "main"); } };
}

function run(tools: string) {
  const p = Bun.spawnSync(["bash", SCRIPT, tools]);
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function freshTools(): string {
  const d = join(root, `tools-${counter++}`);
  mkdirSync(d);
  return d;
}

describe("update-external-tools.sh", () => {
  test("pulls a clean repo that is strictly behind", () => {
    const tools = freshTools();
    const t = makeTool(tools, "behind");
    t.publish("new.txt", "hello\n");
    const r = run(tools);
    expect(r.code).toBe(0);
    expect(existsSync(join(t.dir, "new.txt"))).toBe(true);
    expect(r.out).toContain("updated 1, skipped 0");
    expect(r.out).toContain("updated  behind");
  });

  test("leaves an up-to-date repo alone", () => {
    const tools = freshTools();
    makeTool(tools, "current");
    expect(run(tools).out).toContain("updated 0, skipped 0, already current 1");
  });

  test("skips a dirty repo without touching it", () => {
    const tools = freshTools();
    const t = makeTool(tools, "dirty");
    t.publish("new.txt", "hello\n");
    writeFileSync(join(t.dir, "README.md"), "local edit\n");
    const r = run(tools);
    expect(r.err).toContain("external-tools/dirty: skipped — working tree is dirty");
    expect(existsSync(join(t.dir, "new.txt"))).toBe(false);
    expect(readFileSync(join(t.dir, "README.md"), "utf8")).toBe("local edit\n");
    expect(r.out).toContain("updated 0, skipped 1");
  });

  test("skips a repo with only untracked files", () => {
    const tools = freshTools();
    const t = makeTool(tools, "untracked");
    t.publish("new.txt", "hello\n");
    writeFileSync(join(t.dir, "scratch.txt"), "x");
    expect(run(tools).err).toContain("working tree is dirty");
    expect(existsSync(join(t.dir, "new.txt"))).toBe(false);
  });

  test("skips a repo ahead of origin, naming the count", () => {
    const tools = freshTools();
    const t = makeTool(tools, "ahead");
    commit(t.dir, "a.txt", "1");
    commit(t.dir, "b.txt", "2");
    const before = git(t.dir, "rev-parse", "HEAD");
    const r = run(tools);
    expect(r.err).toContain("external-tools/ahead: skipped — 2 unpushed local commit(s) ahead of origin");
    expect(git(t.dir, "rev-parse", "HEAD")).toBe(before);
  });

  test("skips a diverged repo", () => {
    const tools = freshTools();
    const t = makeTool(tools, "diverged");
    t.publish("remote.txt", "r");
    commit(t.dir, "local.txt", "l");
    const before = git(t.dir, "rev-parse", "HEAD");
    const r = run(tools);
    expect(r.err).toContain("external-tools/diverged: skipped — diverged (1 ahead, 1 behind)");
    expect(git(t.dir, "rev-parse", "HEAD")).toBe(before);
  });

  test("skips a repo on another branch", () => {
    const tools = freshTools();
    const t = makeTool(tools, "branchy");
    t.publish("new.txt", "hello\n");
    git(t.dir, "checkout", "-q", "-b", "feature");
    const r = run(tools);
    expect(r.err).toContain("on branch 'feature', not 'main'");
    expect(git(t.dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
    expect(existsSync(join(t.dir, "new.txt"))).toBe(false);
  });

  test("skips a repo with no commits and one with no upstream", () => {
    const tools = freshTools();
    const empty = join(tools, "empty");
    mkdirSync(empty);
    git(empty, "init", "-q", "-b", "main");
    writeFileSync(join(empty, "f"), "x");
    const local = join(tools, "local");
    mkdirSync(local);
    git(local, "init", "-q", "-b", "main");
    commit(local, "f", "x");
    const r = run(tools);
    expect(r.err).toContain("external-tools/empty: skipped — no commits yet");
    expect(r.err).toContain("external-tools/local: skipped — no upstream configured");
  });

  test("a failing fetch skips that repo and does not abort the others", () => {
    const tools = freshTools();
    const broken = makeTool(tools, "a-broken");
    const good = makeTool(tools, "b-good");
    good.publish("new.txt", "hello\n");
    rmSync(broken.origin, { recursive: true, force: true });
    const r = run(tools);
    expect(r.code).toBe(0);
    expect(r.err).toContain("external-tools/a-broken: skipped — fetch failed");
    expect(existsSync(join(good.dir, "new.txt"))).toBe(true);
  });

  test("ignores directories that are not their own git repo", () => {
    const tools = freshTools();
    mkdirSync(join(tools, "plain"));
    expect(run(tools).out).toContain("updated 0, skipped 0, already current 0");
  });

  test("a changed requirements.txt re-runs pip from the tool's .venv", () => {
    const tools = freshTools();
    const t = makeTool(tools, "pydeps");
    mkdirSync(join(t.dir, ".venv/bin"), { recursive: true });
    const pip = join(t.dir, ".venv/bin/pip");
    writeFileSync(pip, `#!/bin/sh\necho "$@" > "${join(t.dir, "pip.args")}"\n`);
    chmodSync(pip, 0o755);
    t.publish("requirements.txt", "requests\n");
    const r = run(tools);
    expect(r.out).toContain("requirements.txt changed");
    expect(readFileSync(join(t.dir, "pip.args"), "utf8").trim()).toBe("install -q -r requirements.txt");
  });

  test("changed deps without a .venv only warn", () => {
    const tools = freshTools();
    const t = makeTool(tools, "novenv");
    t.publish("requirements.txt", "requests\n");
    const r = run(tools);
    expect(r.err).toContain("requirements.txt changed but there is no .venv");
    expect(r.out).toContain("updated 1");
  });
});
