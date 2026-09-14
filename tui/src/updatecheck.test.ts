import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkForUpdate, eligibleUpdateHead, startUpdateChecks, UPDATE_CHECK_INTERVAL_MS, type UpdateRequest } from "./updatecheck";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function git(root: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function repo() {
  const root = mkdtempSync(join(tmpdir(), "exo-update-"));
  roots.push(root);
  git(root, "init", "-b", "main");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial");
  git(root, "remote", "add", "origin", "https://github.com/Yeyito777/Exocortex.git");
  return root;
}
function response(status: string, ahead_by = 0): UpdateRequest {
  return (async () => Response.json({ status, ahead_by })) as UpdateRequest;
}

describe("mainline update eligibility", () => {
  test("accepts upstream main, including SSH origin", async () => {
    const root = repo();
    expect(await eligibleUpdateHead(root)).toBe(git(root, "rev-parse", "HEAD"));
    git(root, "remote", "set-url", "origin", "git@github.com:Yeyito777/Exocortex.git");
    expect(await eligibleUpdateHead(root)).not.toBeNull();
  });
  test("skips branches, detached HEAD, forks and absent repositories without network", async () => {
    const root = repo();
    let requests = 0;
    const request = (async () => { requests++; return Response.json({}); }) as UpdateRequest;
    git(root, "checkout", "-b", "feature");
    expect(await checkForUpdate(root, request)).toBe(false);
    git(root, "checkout", "--detach");
    expect(await checkForUpdate(root, request)).toBe(false);
    git(root, "checkout", "main");
    git(root, "remote", "set-url", "origin", "https://github.com/someone/Exocortex.git");
    expect(await checkForUpdate(root, request)).toBe(false);
    expect(await checkForUpdate(join(root, "missing"), request)).toBe(false);
    expect(requests).toBe(0);
  });
  test("skips linked worktrees even when they are on main", async () => {
    const root = repo();
    git(root, "checkout", "-b", "dev");
    const worktree = join(root, "linked");
    git(root, "worktree", "add", worktree, "main");
    expect(await eligibleUpdateHead(worktree)).toBeNull();
  });
});

describe("GitHub comparison", () => {
  test("only signals upstream ahead; verifies URL and bounded request", async () => {
    const root = repo();
    const request = (async (url: string, init: RequestInit) => {
      expect(url).toBe(`https://api.github.com/repos/Yeyito777/Exocortex/compare/${git(root, "rev-parse", "HEAD")}...main`);
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ status: "ahead", ahead_by: 3 });
    }) as UpdateRequest;
    expect(await checkForUpdate(root, request)).toBe(true);
    for (const status of ["identical", "behind", "diverged", "unexpected"]) {
      expect(await checkForUpdate(root, response(status, 3))).toBe(false);
    }
    expect(await checkForUpdate(root, response("ahead", 0))).toBe(false);
  });
  test("fails quietly on offline, rate limit and malformed responses", async () => {
    const root = repo();
    for (const request of [
      async () => { throw new Error("offline"); },
      async () => new Response("rate limited", { status: 403 }),
      async () => new Response("not json"),
    ]) expect(await checkForUpdate(root, request as UpdateRequest)).toBe(false);
  });
  test("discards a response if the checkout changes during the request", async () => {
    const root = repo();
    const request = (async () => {
      git(root, "checkout", "-b", "feature");
      return Response.json({ status: "ahead", ahead_by: 1 });
    }) as UpdateRequest;
    expect(await checkForUpdate(root, request)).toBe(false);
  });
});

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test("polls immediately and periodically, emits changes only, and stops", async () => {
  expect(UPDATE_CHECK_INTERVAL_MS).toBe(120_000);
  let calls = 0;
  let available = true;
  const changes: boolean[] = [];
  const stop = startUpdateChecks(async () => { calls++; return available; }, value => changes.push(value), 10);
  try {
    expect(calls).toBe(1);
    await pause(45);
    expect(calls).toBeGreaterThan(1);
    expect(changes).toEqual([true]);
    available = false;
    await pause(30);
    expect(changes).toEqual([true, false]);
  } finally { stop(); }
  const count = calls;
  await pause(25);
  expect(calls).toBe(count);
});

test("does not overlap slow requests or publish after disposal", async () => {
  let resolve!: (value: boolean) => void;
  let calls = 0;
  const changes: boolean[] = [];
  const stop = startUpdateChecks(() => { calls++; return new Promise(done => { resolve = done; }); }, value => changes.push(value), 5);
  await pause(25);
  expect(calls).toBe(1);
  stop();
  resolve(true);
  await pause(10);
  expect(changes).toEqual([]);
});
