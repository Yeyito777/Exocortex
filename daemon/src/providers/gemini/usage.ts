/**
 * Google AI plan quota for the gemini provider.
 *
 * The Antigravity CLI reports quota only on its own `/usage` screen (Gemini
 * models share a five-hour and a weekly limit; Argon has its own weekly one),
 * so Exocortex opens the CLI in a pseudo-terminal, asks for `/usage` and reads
 * the screen: the CLI talks to Google itself, as for turns. Read at most every
 * few minutes, and after turns.
 */

import type { UsageData, UsageWindow } from "@exocortex/shared/messages";
import type { GeminiQuotaWindows } from "@exocortex/shared/protocol";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "../../log";
import { agyBinary, agyEnv, hasAgyBinary } from "./cli";

export interface GeminiQuotaGroup {
  /** Heading as the CLI prints it, e.g. "GEMINI MODELS", "GEMINI 4 ARGON". */
  name: string;
  weekly: UsageWindow | null;
  fiveHour: UsageWindow | null;
}

export interface GeminiQuotaReport {
  account: string | null;
  groups: GeminiQuotaGroup[];
}

const MIN_REFRESH_MS = 3 * 60_000;
const SCREEN_TIMEOUT_MS = 25_000;

let lastUsage: UsageData | null = null;
let lastReport: GeminiQuotaReport | null = null;
let lastReadAt = 0;
/** When lastReport was read. */
let lastReportAt = 0;
let inflight: Promise<GeminiQuotaReport | null> | null = null;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>78]/g;

function parseDuration(text: string): number | null {
  const match = /Refreshes in\s+(?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m)?/i.exec(text);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  return ((Number(match[1] ?? 0) * 24 + Number(match[2] ?? 0)) * 60 + Number(match[3] ?? 0)) * 60_000;
}

/** The `/usage` screen's text (ANSI stripped) as quota groups. */
export function parseUsageScreen(raw: string, now = Date.now()): GeminiQuotaReport | null {
  const lines = raw.replace(ANSI_RE, "").split(/\r?\n|\r/).map(line => line.trim()).filter(Boolean);
  const start = lines.findIndex(line => /Models & Quota/i.test(line));
  if (start < 0) return null;
  const report: GeminiQuotaReport = { account: null, groups: [] };
  let group: GeminiQuotaGroup | null = null;
  let window: "weekly" | "fiveHour" | null = null;
  for (const line of lines.slice(start + 1)) {
    const account = /^Account:\s*(\S+@\S+)/.exec(line);
    if (account) {
      report.account = account[1];
      continue;
    }
    if (/^[A-Z0-9][A-Z0-9 .&-]+$/.test(line) && /[A-Z]{3}/.test(line) && !/%/.test(line)) {
      group = { name: line, weekly: null, fiveHour: null };
      report.groups.push(group);
      window = null;
      continue;
    }
    if (!group) continue;
    if (/weekly limit/i.test(line)) { window = "weekly"; continue; }
    if (/five hour limit/i.test(line)) { window = "fiveHour"; continue; }
    const percent = /(\d+(?:\.\d+)?)%/.exec(line);
    if (percent && window && !group[window]) {
      group[window] = { utilization: Math.round(Math.max(0, Math.min(100, 100 - Number(percent[1]))) * 100) / 100, resetsAt: null };
      continue;
    }
    if (window && group[window]) {
      const ms = parseDuration(line);
      if (ms !== null) group[window] = { ...group[window]!, resetsAt: now + ms };
    }
  }
  return report.groups.length > 0 ? report : null;
}

function sharedGroup(report: GeminiQuotaReport): GeminiQuotaGroup | null {
  return report.groups.find(group => /^GEMINI MODELS$/i.test(group.name))
    ?? report.groups.find(group => /GEMINI/i.test(group.name) && !/ARGON/i.test(group.name))
    ?? null;
}

/** The shared Gemini group (Neon, Hydrogen, Flash) is what the usage bars show. */
export function usageFromReport(report: GeminiQuotaReport): UsageData {
  const gemini = sharedGroup(report);
  return { fiveHour: gemini?.fiveHour ?? null, sevenDay: gemini?.weekly ?? null };
}

/** The Accounts screen's limits: the shared group (the usage bars') and Argon's own. */
export function geminiQuotaLimits(report: GeminiQuotaReport): { shared: GeminiQuotaWindows | null; argon: GeminiQuotaWindows | null } {
  const windows = (group: GeminiQuotaGroup | null | undefined): GeminiQuotaWindows | null => group ? { fiveHour: group.fiveHour, weekly: group.weekly } : null;
  return { shared: windows(sharedGroup(report)), argon: windows(report.groups.find(group => /ARGON/i.test(group.name))) };
}

/** Open the CLI in a pseudo-terminal, ask for `/usage`, and return the screen text. */
async function readUsageScreen(): Promise<string> {
  let screen = "";
  const decoder = new TextDecoder();
  // An empty directory of its own: the CLI asks once whether to trust a folder.
  const cwd = join(tmpdir(), "exocortex-gemini-usage");
  mkdirSync(cwd, { recursive: true });
  const proc = Bun.spawn([agyBinary()], {
    cwd,
    env: agyEnv({ TERM: "xterm-256color" }),
    terminal: {
      cols: 160,
      rows: 60,
      data(_terminal, data) {
        screen += decoder.decode(data, { stream: true });
      },
    },
  });
  const terminal = proc.terminal!;
  const deadline = Date.now() + SCREEN_TIMEOUT_MS;
  const waitFor = async (test: () => boolean) => {
    while (!test() && Date.now() < deadline && proc.exitCode === null) await Bun.sleep(150);
    return test();
  };
  const plain = () => screen.replace(ANSI_RE, "");
  try {
    // Ready once its prompt line shows; first answer the folder-trust question if it asks.
    await waitFor(() => /for shortcuts|trust (the contents of )?this/i.test(plain()));
    if (/trust (the contents of )?this/i.test(plain()) && !/for shortcuts/.test(plain())) {
      terminal.write("\r");
      await waitFor(() => /for shortcuts/.test(plain()));
    }
    await Bun.sleep(500);
    terminal.write("\x1b");
    await Bun.sleep(300);
    terminal.write("/usage");
    await Bun.sleep(600);
    terminal.write("\r");
    await waitFor(() => /Refreshes in|Quota available/.test(screen.replace(ANSI_RE, "").split(/Models & Quota/i)[1] ?? ""));
    await Bun.sleep(800);
    return screen;
  } finally {
    try { proc.kill("SIGKILL"); } catch { /* gone */ }
    terminal.close?.();
  }
}

export async function readGeminiQuota(force = false): Promise<GeminiQuotaReport | null> {
  if (!force && Date.now() - lastReadAt < MIN_REFRESH_MS) return lastReport;
  if (inflight) return inflight;
  if (!hasAgyBinary()) return null;
  inflight = (async () => {
    try {
      const report = parseUsageScreen(await readUsageScreen());
      lastReadAt = Date.now();
      if (report) {
        lastReport = report;
        lastReportAt = lastReadAt;
        lastUsage = usageFromReport(report);
      } else {
        log("warn", "gemini usage: the CLI's /usage screen could not be read");
      }
      return report;
    } catch (error) {
      log("warn", `gemini usage: reading /usage failed: ${error instanceof Error ? error.message : error}`);
      lastReadAt = Date.now();
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function lastGeminiQuota(): GeminiQuotaReport | null {
  return lastReport;
}

/** When `/usage` was last read successfully; 0 before. */
export function lastGeminiQuotaReadAt(): number {
  return lastReport ? lastReportAt : 0;
}

export function getLastUsage(): UsageData | null {
  return lastUsage;
}

/** The last read at once; refreshRemoteUsage reads again when it is a few minutes old. */
export function refreshUsage(onUpdate: (usage: UsageData | null) => void): void {
  onUpdate(lastUsage);
}

export async function refreshRemoteUsage(): Promise<UsageData | null> {
  await readGeminiQuota();
  return lastUsage;
}

export function handleUsageHeaders(_headers: Headers, _onUpdate: (usage: UsageData) => void): void {
  // The CLI talks to Google itself: no response headers reach Exocortex.
}

export function clearUsage(): void {
  lastUsage = null;
  lastReport = null;
  lastReadAt = 0;
  lastReportAt = 0;
}

/**
 * Whether a turn on `model` can run now by the last quota read, for the
 * orchestrator's usage-limit wait; Argon has a weekly limit of its own.
 */
export function geminiUsageAvailability(model: string | null, now = Date.now()): { ready: boolean; resetAt: number | null } {
  const report = lastReport;
  if (!report) return { ready: true, resetAt: null };
  const argon = model?.includes("argon") ?? false;
  const group = report.groups.find(g => argon ? /ARGON/i.test(g.name) : /^GEMINI MODELS$/i.test(g.name));
  if (!group) return { ready: true, resetAt: null };
  const spent = [group.fiveHour, group.weekly].filter((w): w is UsageWindow => !!w && w.utilization >= 100 && (w.resetsAt === null || w.resetsAt > now));
  if (spent.length === 0) return { ready: true, resetAt: null };
  const resets = spent.map(w => w.resetsAt).filter((at): at is number => at !== null);
  return { ready: false, resetAt: resets.length ? Math.max(...resets) : null };
}

/** For tests. */
export function setGeminiQuotaForTest(report: GeminiQuotaReport | null): void {
  lastReport = report;
  lastUsage = report ? usageFromReport(report) : null;
  lastReadAt = lastReportAt = report ? Date.now() : 0;
}
