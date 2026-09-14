import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const UPDATE_CHECK_INTERVAL_MS = 120_000;
const UPSTREAM = "Yeyito777/Exocortex";
export type UpdateRequest = (url: string, init: RequestInit) => Promise<Response>;
export type UpdateStatus = "none" | "update_available" | "restart_needed" | "disabled" | "unknown";

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root, timeout: 5_000, maxBuffer: 64 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
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
  try {
    const response = await request(`https://api.github.com/repos/${UPSTREAM}/compare/${head}...main`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Exocortex-update-check" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const comparison = await response.json() as { status?: string; ahead_by?: number };
    if (!["ahead", "behind", "identical", "diverged"].includes(comparison.status ?? "")) return null;
    // GitHub compares local HEAD (base) to upstream main (head). Local-only
    // commits or divergence are development, not a straightforward update.
    if (comparison.status !== "ahead" || !(Number(comparison.ahead_by) > 0)) return false;
    // A branch switch / pull during the network request invalidates the result.
    return await eligibleUpdateHead(root) === head;
  } catch {
    // Offline, rate-limited, missing Git, etc. must never disrupt startup/UI.
    return null;
  }
}

/**
 * Capture the running daemon's revision ONCE, at startup, not on the first
 * request. A pull changes disk HEAD but must not change this process identity.
 */
export function createUpdateStatusChecker(root: string, request: UpdateRequest = fetch): () => Promise<UpdateStatus> {
  const startedHead = eligibleUpdateHead(root);
  let inFlight: Promise<UpdateStatus> | null = null;
  const check = async (): Promise<UpdateStatus> => {
    const [running, disk] = await Promise.all([startedHead, eligibleUpdateHead(root)]);
    if (!running || !disk) return "disabled";
    // Restart takes precedence, works offline, and does not wait on GitHub.
    if (running !== disk) return "restart_needed";
    const available = await compareUpstream(root, disk, request);
    const current = await eligibleUpdateHead(root);
    if (!current) return "disabled";
    if (current !== running) return "restart_needed";
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
