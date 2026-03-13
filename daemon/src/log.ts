/**
 * File logger for exocortexd.
 *
 * Writes to ~/.config/exocortex/exocortex.log with automatic rotation at 5 MB.
 * Keeps up to 3 rotated files (.log.1, .log.2, .log.3) for ~20 MB total history.
 * Log entries are buffered and flushed asynchronously via microtask to avoid
 * blocking the event loop with synchronous I/O on every call. Rotation is
 * checked at flush time rather than per-entry. A synchronous flush runs on
 * process exit to avoid losing final messages.
 */

import { appendFileSync, appendFile as appendFileCb, mkdirSync, existsSync, statSync, renameSync, unlinkSync } from "fs";
import { join } from "path";
import { configDir } from "@exocortex/shared/paths";

const LOG_DIR = configDir();
const LOG_FILE = join(LOG_DIR, "exocortex.log");
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_LOG_FILES = 3;

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const envLevel = (process.env.EXOCORTEX_LOG_LEVEL ?? "info").toLowerCase();
const minLevel = LEVEL_RANK[envLevel as LogLevel] ?? LEVEL_RANK.info;

const PID = process.pid;
let dirEnsured = false;

function ensureDir(): void {
  if (dirEnsured) return;
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  dirEnsured = true;
}

// ── Async buffered writes ─────────────────────────────────────────

const buffer: string[] = [];
let flushScheduled = false;

/** Rotate the log file if it exceeds the size limit. */
function rotateIfNeeded(): void {
  try {
    const stat = statSync(LOG_FILE);
    if (stat.size >= MAX_LOG_BYTES) {
      try {
        // Rotate: .2→.3, .1→.2, .log→.1 (drop the oldest)
        try { unlinkSync(`${LOG_FILE}.${MAX_LOG_FILES}`); } catch { /* best-effort */ }
        for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
          try { renameSync(`${LOG_FILE}.${i}`, `${LOG_FILE}.${i + 1}`); } catch { /* best-effort */ }
        }
        renameSync(LOG_FILE, `${LOG_FILE}.1`);
      } catch { /* best-effort rotation */ }
    }
  } catch { /* file doesn't exist yet — nothing to rotate */ }
}

/** Async flush — called via microtask so multiple log() calls in the same
 *  synchronous block are batched into a single write. */
function flushAsync(): void {
  flushScheduled = false;
  if (buffer.length === 0) return;

  const content = buffer.join("");
  buffer.length = 0;

  rotateIfNeeded();
  appendFileCb(LOG_FILE, content, () => { /* fire-and-forget */ });
}

/** Synchronous flush — used on process exit to avoid losing final messages. */
function flushSync(): void {
  if (buffer.length === 0) return;

  const content = buffer.join("");
  buffer.length = 0;

  rotateIfNeeded();
  appendFileSync(LOG_FILE, content);
}

process.on("exit", flushSync);

// ── Public API ────────────────────────────────────────────────────

export function log(level: LogLevel, msg: string): void {
  if (LEVEL_RANK[level] < minLevel) return;
  ensureDir();

  const ts = new Date().toISOString();
  buffer.push(`[${ts}] [${PID}] [${level.toUpperCase()}] ${msg}\n`);

  if (!flushScheduled) {
    flushScheduled = true;
    queueMicrotask(flushAsync);
  }
}
