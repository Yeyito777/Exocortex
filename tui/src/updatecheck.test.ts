import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkForUpdate, checkoutFingerprint, createUpdateStatusChecker, eligibleUpdateHead, startUpdateChecks, UPDATE_CHECK_INTERVAL_MS, type UpdateRequest } from "@exocortex/shared/updatecheck";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function git(root: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function repo() {
  const root = mkdtempSync(join(tmpdir(), "exo-update-"));
  roots.push(root);
  git(root, "init", "-b", "main");
  mkdirSync(join(root, "daemon/src"), { recursive: true });
  mkdirSync(join(root, "shared/src"), { recursive: true });
  mkdirSync(join(root, "tui/src"), { recursive: true });
  writeFileSync(join(root, "shared/package.json"), JSON.stringify({ exports: { "./config": "./src/config.ts" } }));
  writeFileSync(join(root, "shared/src/config.ts"), "export interface Config { a?: number }\nexport const DEFAULT = 1;\n");
  writeFileSync(join(root, "daemon/src/main.ts"), 'import { DEFAULT } from "@exocortex/shared/config";\nconsole.log(DEFAULT);\n');
  writeFileSync(join(root, "tui/src/main.ts"), "export const tui = 1;\n");
  git(root, "add", "-A");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial");
  git(root, "remote", "add", "origin", "https://github.com/Yeyito777/Exocortex.git");
  return root;
}
function response(status: string, ahead_by = 0): UpdateRequest {
  return (async () => Response.json({ status, ahead_by })) as UpdateRequest;
}
/** A new commit on the current branch changing one file. */
function commitFile(root: string, path: string, content: string, message = "change") {
  writeFileSync(join(root, path), content);
  git(root, "add", "-A");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message);
}
/** A commit that exists locally (as after a fetch) without moving main. */
function commitTree(root: string, parent = "HEAD") {
  return git(root, "commit-tree", `${parent}^{tree}`, "-p", parent, "-m", "upstream");
}
const pkt = (text: string) => (text.length + 4).toString(16).padStart(4, "0") + text;
/** GitHub's smart-HTTP ref advertisement, HEAD first, as actually served. */
function advertisement(main: string) {
  return new Response(pkt("# service=git-upload-pack\n") + "0000"
    + pkt(`${main} HEAD\0multi_ack symref=HEAD:refs/heads/main agent=git/github\n`)
    + pkt(`${"f".repeat(40)} refs/heads/main-old\n`)
    + pkt(`${main} refs/heads/main\n`)
    + pkt(`${"e".repeat(40)} refs/pull/1/head\n`) + "0000");
}
/** Routes Git's ref advertisement and the rate-limited REST compare API separately. */
function github(main: () => string, compare: UpdateRequest = async () => new Response("rate limited", { status: 403 })) {
  const calls = { refs: 0, api: 0 };
  const request: UpdateRequest = async (url, init) => {
    if (url.endsWith(".git/info/refs?service=git-upload-pack")) {
      calls.refs++;
      return advertisement(main());
    }
    calls.api++;
    return compare(url, init);
  };
  return { request, calls };
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

describe("checkout fingerprint", () => {
  test("is stable until a commit, branch switch or remote change, without running git", async () => {
    const root = repo();
    const before = await checkoutFingerprint(root);
    expect(await checkoutFingerprint(root)).toBe(before);
    commitFile(root, "tui/src/main.ts", "export const tui = 2;\n");
    const committed = await checkoutFingerprint(root);
    expect(committed).not.toBe(before);
    git(root, "checkout", "-q", "-b", "feature");
    const switched = await checkoutFingerprint(root);
    expect(switched).not.toBe(committed);
    git(root, "remote", "set-url", "origin", "https://github.com/someone/Exocortex.git");
    expect(await checkoutFingerprint(root)).not.toBe(switched);
  });
});

describe("GitHub comparison", () => {
  test("frequent status queries share GitHub results until the two-minute cache expires", async () => {
    const root = repo();
    let time = 0;
    let main = git(root, "rev-parse", "HEAD");
    const { request, calls } = github(() => main);
    const checker = createUpdateStatusChecker(root, request, () => time);
    expect(await Promise.all([checker(), checker()])).toEqual(["none", "none"]);
    expect(calls.refs).toBe(1);
    main = commitTree(root);
    for (time = 10_000; time < UPDATE_CHECK_INTERVAL_MS; time += 10_000) {
      expect(await checker()).toBe("none");
    }
    expect(calls.refs).toBe(1);
    expect(await checker()).toBe("update_available");
    expect(calls).toEqual({ refs: 2, api: 0 });
    commitFile(root, "daemon/src/main.ts", "console.log(2);\n");
    time += 10_000;
    expect(await checker()).toBe("restart_needed");
    expect(calls.refs).toBe(2); // Disk checks bypass even a fresh GitHub cache.
  });

  test("failed GitHub checks are throttled too, without delaying restart detection", async () => {
    const root = repo();
    let time = 0;
    const offline = async () => { throw new Error("offline"); };
    const { request, calls } = github(() => { throw new Error("offline"); }, offline);
    const checker = createUpdateStatusChecker(root, request, () => time);
    expect(await checker()).toBe("unknown");
    time = 10_000;
    expect(await checker()).toBe("unknown");
    expect(calls).toEqual({ refs: 1, api: 1 });
    time = UPDATE_CHECK_INTERVAL_MS;
    expect(await checker()).toBe("unknown");
    expect(calls).toEqual({ refs: 2, api: 2 });
    commitFile(root, "daemon/src/main.ts", "console.log(2);\n");
    expect(await checker()).toBe("restart_needed");
    expect(calls).toEqual({ refs: 2, api: 2 });
  });

  test("daemon revision is captured once; downloaded updates need restart even offline", async () => {
    const root = repo();
    const main = git(root, "rev-parse", "HEAD");
    const { request, calls } = github(() => main);
    const running = createUpdateStatusChecker(root, request);
    expect(await running()).toBe("none");
    commitFile(root, "daemon/src/main.ts", "console.log(2);\n");
    expect(await running()).toBe("restart_needed");
    expect(await running()).toBe("restart_needed");
    expect(calls).toEqual({ refs: 1, api: 0 });
    const restarted = createUpdateStatusChecker(root, request);
    expect(await restarted()).toBe("none");
    git(root, "checkout", "-b", "feature");
    expect(await running()).toBe("disabled");
  });

  test("commits that cannot affect the running daemon don't need a restart", async () => {
    const root = repo();
    const checker = createUpdateStatusChecker(root, response("identical"));
    expect(await checker()).toBe("none");
    commitFile(root, "tui/src/main.ts", "export const tui = 2;\n", "tui only");
    expect(await checker()).toBe("none");
    commitFile(root, "shared/src/config.ts", "export interface Config { a?: number; tui?: boolean }\nexport const DEFAULT = 1;\n", "type-only shared");
    expect(await checker()).toBe("none");
    // The first real daemon change since the running revision flags it, and it stays flagged.
    commitFile(root, "daemon/src/main.ts", "console.log(2);\n", "daemon");
    expect(await checker()).toBe("restart_needed");
    commitFile(root, "tui/src/main.ts", "export const tui = 3;\n", "tui again");
    expect(await checker()).toBe("restart_needed");
  });

  test("a TUI-only update doesn't mask an upstream update", async () => {
    const root = repo();
    const checker = createUpdateStatusChecker(root, response("ahead", 1));
    expect(await checker()).toBe("update_available");
    commitFile(root, "tui/src/main.ts", "export const tui = 2;\n");
    expect(await checker()).toBe("update_available");
  });

  test("runtime status distinguishes upstream updates from offline or unsupported responses", async () => {
    const root = repo();
    expect(await createUpdateStatusChecker(root, response("ahead", 2))()).toBe("update_available");
    expect(await createUpdateStatusChecker(root, async () => { throw new Error("offline"); })()).toBe("unknown");
    expect(await createUpdateStatusChecker(root, async () => new Response("rate limited", { status: 403 }))()).toBe("unknown");
    const disabled = createUpdateStatusChecker(join(root, "missing"), async () => { throw new Error("must not request"); });
    expect(await disabled()).toBe("disabled");
  });

  test("git timing out (a loaded machine) is Unknown, never Disabled, and the startup capture is retried", async () => {
    const root = repo();
    const bin = mkdtempSync(join(tmpdir(), "exo-killed-git-"));
    roots.push(bin);
    // Stands in for git killed by execFile's timeout: it dies by a signal.
    writeFileSync(join(bin, "git"), "#!/bin/sh\nkill -TERM $$\n", { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    let checker: () => Promise<string>;
    try {
      checker = createUpdateStatusChecker(root, response("identical"));
      expect(await checker()).toBe("unknown");
    } finally {
      process.env.PATH = path;
    }
    expect(await checker!()).toBe("none");
  });

  test("a pull during the upstream request yields Restart needed, not None", async () => {
    const root = repo();
    git(root, "checkout", "-b", "side");
    commitFile(root, "daemon/src/main.ts", "console.log(2);\n");
    const update = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "main");
    const checker = createUpdateStatusChecker(root, github(() => {
      git(root, "merge", "--ff-only", update);
      return update;
    }).request);
    expect(await checker()).toBe("restart_needed");
  });

  test("a TUI-only pull during the request is classified, not reported as Restart needed", async () => {
    const root = repo();
    git(root, "checkout", "-b", "side");
    commitFile(root, "tui/src/main.ts", "export const tui = 2;\n");
    const update = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "main");
    let pulled = false;
    const checker = createUpdateStatusChecker(root, github(() => {
      if (!pulled) git(root, "merge", "--ff-only", update);
      pulled = true;
      return update;
    }).request);
    expect(await checker()).toBe("none");
  });

  test("only signals upstream ahead; verifies URLs and bounded requests", async () => {
    const root = repo();
    const urls: string[] = [];
    const request = (async (url: string, init: RequestInit) => {
      urls.push(url);
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return url.includes("/info/refs") ? advertisement("a".repeat(40)) : Response.json({ status: "ahead", ahead_by: 3 });
    }) as UpdateRequest;
    expect(await checkForUpdate(root, request)).toBe(true);
    expect(urls).toEqual([
      "https://github.com/Yeyito777/Exocortex.git/info/refs?service=git-upload-pack",
      `https://api.github.com/repos/Yeyito777/Exocortex/compare/${git(root, "rev-parse", "HEAD")}...main`,
    ]);
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
    const update = commitTree(root);
    const { request } = github(() => {
      git(root, "checkout", "-b", "feature");
      return update;
    });
    expect(await checkForUpdate(root, request)).toBe(false);
  });
});

describe("upstream ref advertisement", () => {
  test("current main never touches GitHub's rate-limited REST API", async () => {
    const root = repo();
    const { request, calls } = github(() => git(root, "rev-parse", "HEAD"));
    expect(await createUpdateStatusChecker(root, request)()).toBe("none");
    expect(calls).toEqual({ refs: 1, api: 0 });
  });

  test("a locally known upstream commit is classified by ancestry, offline from the API", async () => {
    const root = repo();
    const initial = git(root, "rev-parse", "HEAD");
    const update = commitTree(root);
    const { request, calls } = github(() => update);
    expect(await createUpdateStatusChecker(root, request)()).toBe("update_available");
    // Unpushed local commits: GitHub's compare API would 404 on this HEAD.
    git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "local work");
    const ahead = github(() => initial);
    expect(await createUpdateStatusChecker(root, ahead.request)()).toBe("none");
    // Diverged: development, not a straightforward update.
    const diverged = github(() => commitTree(root, initial));
    expect(await createUpdateStatusChecker(root, diverged.request)()).toBe("none");
    expect([calls.api, ahead.calls.api, diverged.calls.api]).toEqual([0, 0, 0]);
  });

  test("only an unseen upstream commit or unreadable advertisement falls back to the API", async () => {
    const root = repo();
    const unseen = github(() => "a".repeat(40), response("ahead", 1));
    expect(await createUpdateStatusChecker(root, unseen.request)()).toBe("update_available");
    expect(unseen.calls).toEqual({ refs: 1, api: 1 });
    expect(await createUpdateStatusChecker(root, github(() => "a".repeat(40)).request)()).toBe("unknown");
    const portal = (async (url: string) => url.includes("/info/refs")
      ? new Response("<!DOCTYPE html><title>Sign in</title>")
      : Response.json({ status: "identical", ahead_by: 0 })) as UpdateRequest;
    expect(await createUpdateStatusChecker(root, portal)()).toBe("none");
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
