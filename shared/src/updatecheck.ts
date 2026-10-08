import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const UPDATE_CHECK_INTERVAL_MS = 120_000;
export const DAEMON_STATUS_INTERVAL_MS = 10_000;
const UPSTREAM = "Yeyito777/Exocortex";
export type UpdateRequest = (url: string, init: RequestInit) => Promise<Response>;
export type UpdateStatus = "none" | "update_available" | "restart_needed" | "disabled" | "unknown";

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root, timeout: 5_000, maxBuffer: 64 * 1024,
    // Partial clones must not lazily fetch a missing upstream commit.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" },
  });
  return stdout.trim();
}

/** Only the primary upstream checkout on main participates; never linked worktrees. */
export async function eligibleUpdateHead(root: string): Promise<string | null> {
  try {
    if (!(await lstat(join(root, ".git"))).isDirectory()) return null;
    const [branch, origin, head] = await Promise.all([
      git(root, "symbolic-ref", "--quiet", "--short", "HEAD"),
      git(root, "remote", "get-url", "origin"),
      git(root, "rev-parse", "HEAD"),
    ]);
    if (branch !== "main") return null;
    if (!/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)Yeyito777\/Exocortex(?:\.git)?\/?$/i.test(origin)) return null;
    return /^[a-f0-9]{40,64}$/.test(head) ? head : null;
  } catch {
    return null;
  }
}

/** Read-only: no fetch, checkout, pull, or changes to the user's repository. */
export async function checkForUpdate(root: string, request: UpdateRequest = fetch): Promise<boolean> {
  const head = await eligibleUpdateHead(root);
  if (!head) return false;
  return await compareUpstream(root, head, request) === true;
}

async function compareUpstream(root: string, head: string, request: UpdateRequest): Promise<boolean | null> {
  const upstream = await upstreamMain(request);
  if (upstream === head) return false;
  // Local-only commits or divergence are development, not a straightforward
  // update. Once upstream's commit is local, ancestry answers that offline.
  // Only an unseen upstream commit needs GitHub's rate-limited REST API.
  const available = (upstream ? await isAncestor(root, head, upstream) : null)
    ?? await compareWithApi(head, request);
  if (available !== true) return available;
  // A branch switch / pull during the network request invalidates the result.
  return await eligibleUpdateHead(root) === head;
}

/**
 * Upstream main from Git's smart-HTTP ref advertisement. Unlike the REST API's
 * 60 unauthenticated requests/hour per IP, it isn't exhausted by everyone else
 * behind a shared campus/office NAT.
 */
async function upstreamMain(request: UpdateRequest): Promise<string | null> {
  try {
    const response = await request(`https://github.com/${UPSTREAM}.git/info/refs?service=git-upload-pack`, {
      headers: { "User-Agent": "Exocortex-update-check" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    // pkt-line lengths count bytes; latin1 keeps one character per byte.
    const advertisement = Buffer.from(await response.arrayBuffer()).toString("latin1");
    for (let at = 0; at + 4 <= advertisement.length;) {
      const length = advertisement.slice(at, at + 4);
      if (!/^[a-f0-9]{4}$/i.test(length)) return null;
      // Flush/delimiter packets (< 4) carry no payload.
      const end = at + Math.max(4, Number.parseInt(length, 16));
      const ref = /^([a-f0-9]{40,64}) refs\/heads\/main(?:\0|\n|$)/.exec(advertisement.slice(at + 4, end));
      if (ref) return ref[1];
      at = end;
    }
    return null;
  } catch {
    return null;
  }
}

/** null when either commit is missing locally or Git fails. */
async function isAncestor(root: string, ancestor: string, descendant: string): Promise<boolean | null> {
  try {
    await git(root, "merge-base", "--is-ancestor", ancestor, descendant);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === 1 ? false : null;
  }
}

async function compareWithApi(head: string, request: UpdateRequest): Promise<boolean | null> {
  try {
    const response = await request(`https://api.github.com/repos/${UPSTREAM}/compare/${head}...main`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Exocortex-update-check" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const comparison = await response.json() as { status?: string; ahead_by?: number };
    if (!["ahead", "behind", "identical", "diverged"].includes(comparison.status ?? "")) return null;
    // GitHub compares local HEAD (base) to upstream main (head).
    return comparison.status === "ahead" && Number(comparison.ahead_by) > 0;
  } catch {
    // Offline, rate-limited, etc. must never disrupt startup/UI.
    return null;
  }
}

/**
 * Capture the running daemon's revision ONCE, at startup, not on the first
 * request. A pull changes disk HEAD but must not change this process identity.
 */
export function createUpdateStatusChecker(
  root: string,
  request: UpdateRequest = fetch,
  now: () => number = () => performance.now(),
): () => Promise<UpdateStatus> {
  const startedHead = eligibleUpdateHead(root);
  let inFlight: Promise<UpdateStatus> | null = null;
  // Shared by every client of this daemon. Cache failures too, so offline or
  // rate-limited hosts aren't retried at the faster local-status cadence.
  let upstream: { head: string; available: boolean | null; expiresAt: number } | null = null;
  const check = async (): Promise<UpdateStatus> => {
    const [running, disk] = await Promise.all([startedHead, eligibleUpdateHead(root)]);
    if (!running || !disk) {
      upstream = null;
      return "disabled";
    }
    // Restart takes precedence, works offline, and does not wait on GitHub.
    if (running !== disk) {
      upstream = null;
      return "restart_needed";
    }
    const cached = upstream?.head === disk && now() < upstream.expiresAt ? upstream : null;
    const available = cached ? cached.available : await compareUpstream(root, disk, request);
    const current = await eligibleUpdateHead(root);
    if (!current || current !== running) {
      upstream = null;
      return current ? "restart_needed" : "disabled";
    }
    if (!cached) upstream = { head: disk, available, expiresAt: now() + UPDATE_CHECK_INTERVAL_MS };
    return available === null ? "unknown" : available ? "update_available" : "none";
  };
  return () => {
    if (!inFlight) inFlight = check().finally(() => { inFlight = null; });
    return inFlight;
  };
}

export function startUpdateChecks(
  check: () => Promise<boolean>,
  onChange: (available: boolean) => void,
  intervalMs = UPDATE_CHECK_INTERVAL_MS,
): () => void {
  let stopped = false;
  let inFlight = false;
  let previous = false;
  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const available = await check();
      if (!stopped && available !== previous) {
        previous = available;
        onChange(available);
      }
    } catch {
      // A failed background check must not become an unhandled rejection.
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}
