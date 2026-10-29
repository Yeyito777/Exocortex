/**
 * When the daemon prunes Claude Code session files (session-prune.ts): once a
 * day, the first time a while after it starts, in a process of its own so
 * reading the transcripts never holds up the daemon. Sessions its running
 * processes hold are named to it and stay.
 */

import { spawn } from "node:child_process";
import { join } from "path";
import { log } from "../../log";
import { listClaudeAccounts } from "./accounts";
import { heldClaudeSessionIds } from "./session";
import { ensureClaudeTranscriptRetention } from "./session-prune";

const FIRST_PRUNE_DELAY_MS = 10 * 60_000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60_000;
const PRUNE_TIMEOUT_MS = 30 * 60_000;
const CLI = join(import.meta.dir, "session-prune-cli.ts");

/** Give each Claude configuration directory a long transcript retention where none is set; logs what changed. */
export function ensureClaudeRetentionSettings(): void {
  try {
    for (const result of ensureClaudeTranscriptRetention(listClaudeAccounts().map(account => account.configDir))) {
      if (result.outcome === "set") log("info", `anthropic: set cleanupPeriodDays in ${result.path}, so Claude Code keeps the sessions Exocortex resumes (Exocortex prunes its own)`);
      else if (result.outcome === "unreadable") log("warn", `anthropic: could not read ${result.path} (${result.detail}); Claude Code may delete sessions older than its cleanupPeriodDays`);
    }
  } catch (error) {
    log("warn", `anthropic: checking Claude Code's transcript retention failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function runPrune(): void {
  const child = spawn(process.execPath, [CLI, "--apply", "--json", "--protect", heldClaudeSessionIds().join(",")], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
  const timer = setTimeout(() => child.kill("SIGTERM"), PRUNE_TIMEOUT_MS);
  timer.unref?.();
  child.on("error", error => log("warn", `anthropic: Claude Code session prune could not start: ${error.message}`));
  child.on("close", (code) => {
    clearTimeout(timer);
    if (code !== 0) {
      log("warn", `anthropic: Claude Code session prune exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
      return;
    }
    try {
      const report = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
      const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
      log("info", `anthropic: Claude Code session prune moved ${report.result?.removedFiles ?? 0} files (${gib(report.result?.removedBytes ?? 0)}) to ${report.result?.quarantined?.join(", ") || "the quarantine"} (purged ${report.result?.purged?.length ?? 0} old days), kept ${report.keep?.files} (${gib(report.keep?.bytes ?? 0)}), held ${report.held?.files} recent or running, ${report.aliases} aliases, ${report.result?.errors?.length ?? 0} errors, planned in ${report.planMs} ms`);
    } catch {
      log("warn", `anthropic: Claude Code session prune printed no report`);
    }
  });
}

/** Start the daily prune; returns a function that stops it. */
export function scheduleClaudeSessionPrune(): () => void {
  let interval: ReturnType<typeof setInterval> | null = null;
  const first = setTimeout(() => {
    runPrune();
    interval = setInterval(runPrune, PRUNE_INTERVAL_MS);
    interval.unref?.();
  }, FIRST_PRUNE_DELAY_MS);
  first.unref?.();
  return () => {
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}
