/**
 * @exocortex/shared — Path resolution with git worktree isolation.
 *
 * All paths are resolved relative to the repo root, detected from
 * the source file's own location via import.meta.dir. This means
 * everything works regardless of CWD or where the repo is moved to.
 * Tests can override the config root via EXOCORTEX_CONFIG_DIR; using
 * the live repo config during tests is rejected unless explicitly allowed.
 *
 * Directory layout under <repo>/config/:
 *
 *   config root/        system.md, theme.json (tracked config)
 *   secrets/            env, credentials.json (never tracked)
 *   data/               conversations/, trash/, trash/external-tools/ (bulk data, never tracked)
 *   runtime/            PID, socket, logs, usage.json (ephemeral)
 *   cron/               scheduled job scripts (persistent, not tracked)
 *   storage/            fix-auth.md, token-stats/ (persistent user-local, not tracked)
 *
 * When running from a linked git worktree, runtime paths (socket, PID, logs)
 * and data paths (conversations) are namespaced by worktree name.
 * This lets multiple daemons coexist — one per worktree — without
 * conflicting. Secrets are always shared (same user, same API key).
 */

import { execSync } from "child_process";
import { join, basename, resolve, dirname } from "path";

// ── Repo root ───────────────────────────────────────────────────────
// On Linux (dev): this file lives at <repo>/shared/src/paths.ts — two levels up is the repo root.
// On Windows (compiled exe): import.meta.dir is meaningless inside the bundle,
// so we use the directory containing the executable as the root.

function detectRepoRoot(): string {
  if (process.platform !== "win32") {
    return resolve(import.meta.dir, "../..");
  }
  // Compiled Bun exe on Windows — try multiple approaches
  if (process.execPath && dirname(process.execPath) !== "\\") {
    return dirname(process.execPath);
  }
  if (process.argv[0] && dirname(resolve(process.argv[0])) !== "\\") {
    return dirname(resolve(process.argv[0]));
  }
  // Last resort: use CWD (user should run from the exe's directory)
  return process.cwd();
}

const REPO_ROOT = detectRepoRoot();
const DEFAULT_CONFIG_DIR = join(REPO_ROOT, "config");
const CONFIG_DIR = process.env.EXOCORTEX_CONFIG_DIR?.trim()
  ? resolve(process.env.EXOCORTEX_CONFIG_DIR)
  : DEFAULT_CONFIG_DIR;

function isTestProcess(): boolean {
  return process.env.NODE_ENV === "test" || process.env.EXOCORTEX_TEST === "1";
}

if (
  isTestProcess()
  && resolve(CONFIG_DIR) === resolve(DEFAULT_CONFIG_DIR)
  && process.env.EXOCORTEX_ALLOW_LIVE_CONFIG_IN_TESTS !== "1"
) {
  throw new Error(
    "Refusing to use the live Exocortex config directory during tests. " +
    "Set EXOCORTEX_CONFIG_DIR to an isolated temp dir, or set " +
    "EXOCORTEX_ALLOW_LIVE_CONFIG_IN_TESTS=1 for intentional debugging."
  );
}

// ── Worktree detection ──────────────────────────────────────────────

let _worktreeName: string | null | undefined; // undefined = not yet detected

/**
 * Detect if we're in a linked git worktree.
 * Returns the worktree name if so, null otherwise.
 * Result is cached after first call.
 */
function detectWorktree(): string | null {
  if (_worktreeName !== undefined) return _worktreeName;

  try {
    const gitDir = execSync("git rev-parse --git-dir", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const gitCommonDir = execSync("git rev-parse --git-common-dir", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    // In a linked worktree, --git-dir is something like
    //   /path/to/main/.git/worktrees/<name>
    // while --git-common-dir is
    //   /path/to/main/.git
    // Resolve both to absolute paths to avoid relative/absolute mismatches.
    if (resolve(gitDir) !== resolve(gitCommonDir)) {
      _worktreeName = basename(gitDir);
    } else {
      _worktreeName = null;
    }
  } catch {
    // Not in a git repo, or git not available
    _worktreeName = null;
  }

  return _worktreeName;
}

// ── Platform ───────────────────────────────────────────────────────

/** True when running on Windows. */
export const isWindows: boolean = process.platform === "win32";

// ── Public API ──────────────────────────────────────────────────────

/** Repository root, resolved from this source file's location. */
export function repoRoot(): string {
  return REPO_ROOT;
}

/** Base config directory (<repo>/config). */
export function configDir(): string {
  return CONFIG_DIR;
}

/** External tools directory (<repo>/external-tools). */
export function externalToolsDir(): string {
  return join(REPO_ROOT, "external-tools");
}

/** Secrets directory — API keys, OAuth tokens. Shared across worktrees. */
export function secretsDir(): string {
  return join(CONFIG_DIR, "secrets");
}

/** Data directory — conversations, trash. Namespaced by worktree. */
export function dataDir(): string {
  const wt = detectWorktree();
  return wt
    ? join(CONFIG_DIR, "data", "instances", wt)
    : join(CONFIG_DIR, "data");
}

/** Cron directory — scheduled job scripts. */
export function cronDir(): string {
  return join(CONFIG_DIR, "cron");
}

/** Storage directory — docs, misc persistent user-local files. */
export function storageDir(): string {
  return join(CONFIG_DIR, "storage");
}

/** Token stats directory — persistent daemon-owned accounting data. Shared across worktrees, file names are instance-scoped. */
export function tokenStatsDir(): string {
  return join(storageDir(), "token-stats");
}

/** Runtime dir for socket, PID, logs, usage. Namespaced by worktree. */
export function runtimeDir(): string {
  const wt = detectWorktree();
  return wt
    ? join(CONFIG_DIR, "runtime", wt)
    : join(CONFIG_DIR, "runtime");
}

/** Full path to the daemon socket (or named pipe on Windows). */
export function socketPath(): string {
  if (isWindows) {
    const wt = detectWorktree();
    return wt ? `\\\\.\\pipe\\exocortexd-${wt}` : `\\\\.\\pipe\\exocortexd`;
  }
  return join(runtimeDir(), "exocortexd.sock");
}

/** Full path to the daemon PID file. */
export function pidPath(): string {
  return join(runtimeDir(), "exocortexd.pid");
}

/** Conversations directory. Isolated per worktree to prevent data conflicts. */
export function conversationsDir(): string {
  return join(dataDir(), "conversations");
}

/** Trash directory for soft-deleted conversations and other recoverable data. Isolated per worktree. */
export function trashDir(): string {
  return join(dataDir(), "trash");
}

/** Trash directory for soft-deleted external tools. Isolated per worktree. */
export function externalToolsTrashDir(): string {
  return join(trashDir(), "external-tools");
}

/** The worktree name if in a linked worktree, null otherwise. */
export function worktreeName(): string | null {
  return detectWorktree();
}
