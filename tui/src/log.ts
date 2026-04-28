/**
 * File logger for the TUI.
 *
 * The terminal UI owns stdout/stderr for rendering, so diagnostics go to a
 * runtime log file instead of the terminal. Kept separate from the daemon log so
 * client-side stream repair/delivery issues can be correlated with daemon events.
 */

import { appendFile as appendFileCb, appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { runtimeDir } from "@exocortex/shared/paths";

const LOG_DIR = runtimeDir();
const LOG_FILE = join(LOG_DIR, "exocortex-tui.log");
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_LOG_FILES = 3;

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const envLevel = (process.env.EXOCORTEX_TUI_LOG_LEVEL ?? process.env.EXOCORTEX_LOG_LEVEL ?? "info").toLowerCase();
const minLevel = LEVEL_RANK[envLevel as LogLevel] ?? LEVEL_RANK.info;

const PID = process.pid;
let dirEnsured = false;
const buffer: string[] = [];
let flushScheduled = false;

function ensureDir(): void {
  if (dirEnsured) return;
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  dirEnsured = true;
}

function rotateIfNeeded(): void {
  try {
    const stat = statSync(LOG_FILE);
    if (stat.size < MAX_LOG_BYTES) return;
    try { unlinkSync(`${LOG_FILE}.${MAX_LOG_FILES}`); } catch { /* best effort */ }
    for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
      try { renameSync(`${LOG_FILE}.${i}`, `${LOG_FILE}.${i + 1}`); } catch { /* best effort */ }
    }
    try { renameSync(LOG_FILE, `${LOG_FILE}.1`); } catch { /* best effort */ }
  } catch {
    // File does not exist yet.
  }
}

function flushAsync(): void {
  flushScheduled = false;
  if (buffer.length === 0) return;
  const content = buffer.join("");
  buffer.length = 0;
  rotateIfNeeded();
  appendFileCb(LOG_FILE, content, () => { /* fire-and-forget */ });
}

function flushSync(): void {
  if (buffer.length === 0) return;
  const content = buffer.join("");
  buffer.length = 0;
  rotateIfNeeded();
  appendFileSync(LOG_FILE, content);
}

process.on("exit", flushSync);

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
