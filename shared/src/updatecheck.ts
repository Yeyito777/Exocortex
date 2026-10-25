import { execFile } from "node:child_process";
import { lstat, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { asGitUnavailable, changesAffectDaemon, daemonImportClosure, GitUnavailableError } from "./restart-impact";

const execFileAsync = promisify(execFile);
export const UPDATE_CHECK_INTERVAL_MS = 120_000;
export const DAEMON_STATUS_INTERVAL_MS = 10_000;
/** How often a daemon's status service looks at the checkout (a few stat calls). */
export const CHECKOUT_POLL_INTERVAL_MS = 2_000;
/** Unknown checks in a row before a known status gives way (git timing out on a loaded machine). */
export const UNKNOWN_CHECKS_BEFORE_SHOWN = 3;
/** How long after startup a running revision git couldn't read is retried. */
const STARTUP_CAPTURE_RETRY_MS = 120_000;
const UPSTREAM = "Yeyito777/Exocortex";
export type UpdateRequest = (url: string, init: RequestInit) => Promise<Response>;
export type UpdateStatus = "none" | "update_available" | "restart_needed" | "disabled" | "unknown";

async function git(root: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: root, timeout: 5_000, maxBuffer: 64 * 1024,
      // Partial clones must not lazily fetch a missing upstream commit.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" },
    });
    return stdout.trim();
  } catch (err) {
    throw asGitUnavailable(err);
  }
}

/**
 * HEAD when this is the primary upstream checkout on main, else null. Throws
 * GitUnavailableError when git timed out or couldn't start: that says nothing
 * about eligibility, and must not read as Disabled.
 */
async function readUpdateHead(root: string): Promise<string | null> {
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
  } catch (err) {
    if (err instanceof GitUnavailableError) throw err;
    return null;
  }
}

/** Only the primary upstream checkout on main participates; never linked worktrees. */
export async function eligibleUpdateHead(root: string): Promise<string | null> {
  try { return await readUpdateHead(root); } catch { return null; }
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
 *
 * A newer disk HEAD only needs a restart if the files changed since the
 * running revision can alter the daemon (see restart-impact.ts); TUI-only,
 * docs-only and test-only commits don't. Any doubt means restart.
 */
export function createUpdateStatusChecker(
  root: string,
  request: UpdateRequest = fetch,
  now: () => number = () => performance.now(),
): () => Promise<UpdateStatus> {
  // If git can't answer at startup (a loaded machine), retry the capture on
  // later checks, but only briefly: a HEAD read much later may already be a
  // pulled revision this daemon isn't running. After that, Unknown.
  const createdAt = now();
  const capture = () => {
    const head = readUpdateHead(root);
    head.catch(() => {}); // awaited by the next check; never an unhandled rejection
    return head;
  };
  let startedHead = capture();
  const runningHead = async (): Promise<string | null> => {
    try {
      return await startedHead;
    } catch (err) {
      if (!(err instanceof GitUnavailableError) || now() - createdAt > STARTUP_CAPTURE_RETRY_MS) throw err;
      startedHead = capture();
      return await startedHead;
    }
  };
  let inFlight: Promise<UpdateStatus> | null = null;
  // Shared by every client of this daemon. Cache failures too, so offline or
  // rate-limited hosts aren't retried at the faster local-status cadence.
  let upstream: { head: string; available: boolean | null; expiresAt: number } | null = null;
  // The status check runs every few seconds; classify each revision pair once.
  // A git timeout isn't an answer, so it isn't kept.
  let impact: { key: string; restart: Promise<boolean> } | null = null;
  const restartNeeded = (running: string, disk: string): Promise<boolean> => {
    if (running === disk) return Promise.resolve(false);
    const key = `${running}..${disk}`;
    if (impact?.key !== key) {
      const entry: { key: string; restart: Promise<boolean> } = {
        key,
        restart: daemonImportClosure(root)
          .then(closure => changesAffectDaemon(root, running, disk, closure))
          .catch((err) => {
            if (!(err instanceof GitUnavailableError)) return true;
            if (impact === entry) impact = null;
            throw err;
          }),
      };
      impact = entry;
    }
    return impact.restart;
  };
  const classify = async (retry: boolean): Promise<UpdateStatus> => {
    const [running, disk] = await Promise.all([runningHead(), readUpdateHead(root)]);
    if (!running || !disk) {
      upstream = null;
      return "disabled";
    }
    // Restart takes precedence, works offline, and does not wait on GitHub.
    if (await restartNeeded(running, disk)) {
      upstream = null;
      return "restart_needed";
    }
    const cached = upstream?.head === disk && now() < upstream.expiresAt ? upstream : null;
    const available = cached ? cached.available : await compareUpstream(root, disk, request);
    const current = await readUpdateHead(root);
    if (!current) {
      upstream = null;
      return "disabled";
    }
    if (current !== disk) {
      // Checked out or pulled during the request: classify the new revision.
      upstream = null;
      if (await restartNeeded(running, current)) return "restart_needed";
      return retry ? classify(false) : "unknown";
    }
    if (!cached) upstream = { head: disk, available, expiresAt: now() + UPDATE_CHECK_INTERVAL_MS };
    return available === null ? "unknown" : available ? "update_available" : "none";
  };
  const check = async (): Promise<UpdateStatus> => {
    try {
      return await classify(true);
    } catch (err) {
      if (err instanceof GitUnavailableError) return "unknown";
      throw err;
    }
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

/**
 * Everything a pull, commit, branch switch or remote change rewrites under
 * .git: when this is unchanged, so is the answer that needs no network.
 */
export async function checkoutFingerprint(root: string): Promise<string> {
  const parts = await Promise.all(["HEAD", "refs/heads/main", "packed-refs", "config"].map(async (file) => {
    try {
      const info = await stat(join(root, ".git", file));
      return `${info.ino}:${info.size}:${info.mtimeMs}`;
    } catch {
      return "-";
    }
  }));
  return parts.join("|");
}

export interface UpdateStatusService {
  /** The status as of now: waits for the first check, rechecks if the checkout changed. */
  current(): Promise<UpdateStatus>;
  /** The last published status without waiting; null before the first check. */
  peek(): UpdateStatus | null;
  /** Called with each published change. */
  subscribe(listener: (status: UpdateStatus) => void): () => void;
  /** Keep the status warm in the background: stat the checkout, ask GitHub every refresh. */
  start(): void;
  stop(): void;
}

/**
 * The daemon's update status, kept ready instead of computed per request. The
 * checkout is stat'ed every couple of seconds (no git process) and classified
 * again only when it changed; GitHub is asked again when its cached answer
 * expires. Unknown (git timing out) replaces a known status only after
 * UNKNOWN_CHECKS_BEFORE_SHOWN checks in a row, so clients can show pushes as is.
 */
export function createUpdateStatusService(
  root: string,
  check: () => Promise<UpdateStatus> = createUpdateStatusChecker(root),
  options: {
    pollMs?: number;
    refreshMs?: number;
    retryMs?: number;
    fingerprint?: (root: string) => Promise<string>;
    now?: () => number;
  } = {},
): UpdateStatusService {
  const pollMs = options.pollMs ?? CHECKOUT_POLL_INTERVAL_MS;
  const refreshMs = options.refreshMs ?? UPDATE_CHECK_INTERVAL_MS;
  const retryMs = options.retryMs ?? DAEMON_STATUS_INTERVAL_MS;
  const fingerprint = options.fingerprint ?? checkoutFingerprint;
  const now = options.now ?? (() => performance.now());
  const listeners = new Set<(status: UpdateStatus) => void>();
  let status: UpdateStatus | null = null;
  let checkedFingerprint: string | null = null;
  let checkedAt = -Infinity;
  let unknownChecks = 0;
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const publish = (next: UpdateStatus) => {
    if (next === "unknown" && status !== null && status !== "unknown"
        && ++unknownChecks < UNKNOWN_CHECKS_BEFORE_SHOWN) return;
    unknownChecks = 0;
    if (next === status) return;
    status = next;
    for (const listener of listeners) {
      try { listener(next); } catch { /* a listener must not stop the others */ }
    }
  };
  const refresh = (): Promise<void> => {
    inFlight ??= (async () => {
      try {
        const before = await fingerprint(root);
        let next: UpdateStatus;
        try { next = await check(); } catch { next = "unknown"; }
        checkedFingerprint = before;
        checkedAt = now();
        publish(next);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
  /**
   * Recheck when the checkout changed or GitHub's answer is due; after an
   * Unknown, at the cadence clients used to poll (offline stays cheap).
   */
  const stale = async (): Promise<boolean> => {
    const age = now() - checkedAt;
    if (status === null || age >= refreshMs) return true;
    if ((status === "unknown" || unknownChecks > 0) && age >= retryMs) return true;
    return await fingerprint(root) !== checkedFingerprint;
  };
  const tick = async () => {
    try {
      if (await stale()) await refresh();
    } catch { /* never an unhandled rejection from a timer */ }
  };

  return {
    async current() {
      if (inFlight) await inFlight;
      if (await stale()) await refresh();
      return status ?? "unknown";
    },
    peek: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    start() {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, pollMs);
      timer.unref?.();
      void tick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      listeners.clear();
    },
  };
}
