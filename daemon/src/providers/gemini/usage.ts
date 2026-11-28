/**
 * Google AI plan quota for the gemini provider.
 *
 * The Antigravity CLI reports quota only on its own `/usage` screen (Gemini
 * models share a five-hour and a weekly limit; Argon has its own weekly one),
 * so Exocortex opens the CLI in a pseudo-terminal, asks for `/usage` and reads
 * the screen: the CLI talks to Google itself, as for turns. Read at most every
 * few minutes, and after turns.
 *
 * A turn the plan refuses (stream.ts) says when the quota resets ("Resets in
 * 4h16m56s"). That refusal holds Gemini turns until then, shows on the usage
 * bars and the Accounts rows over whatever the last screen read said, and is
 * kept on disk so a daemon restart still waits; the screen is read again at
 * once and wins where it says the window stays spent for longer.
 */

import type { UsageData, UsageWindow } from "@exocortex/shared/messages";
import type { GeminiQuotaWindows } from "@exocortex/shared/protocol";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataDir } from "@exocortex/shared/paths";
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
/** A refusal that gives no reset time is checked again after this long, as an unknown Claude refusal is. */
const UNKNOWN_RESET_RECHECK_MS = 60_000;
const REFUSAL_FILE = "gemini-quota-refusal.json";
const SCREEN_TIMEOUT_MS = 25_000;

let lastUsage: UsageData | null = null;
let lastReport: GeminiQuotaReport | null = null;
let lastReadAt = 0;
/** When lastReport was read. */
let lastReportAt = 0;
let inflight: Promise<GeminiQuotaReport | null> | null = null;
/** Bumped by clearUsage: a read started before it does not bring the old limits back. */
let generation = 0;

/** The plan's last refusal of a turn, while it holds. */
interface GeminiQuotaRefusal {
  /** Refused on Argon, which follows a group of its own when the screen lists one. */
  argon: boolean;
  /** When the refusal said the quota resets; null when it did not say. */
  resetAt: number | null;
  /** Until when it holds: its reset, or a re-check a minute on. */
  until: number;
}

/** undefined: not read from disk yet. */
let refusal: GeminiQuotaRefusal | null | undefined;
let usageListener: ((usage: UsageData | null) => void) | null = null;

/** Gemini's usage changed outside a turn's end (a refusal, the read after it): the usage bars and Accounts screen follow. */
export function setGeminiUsageListener(listener: ((usage: UsageData | null) => void) | null): void {
  usageListener = listener;
}

/** The plan refused a turn or a helper request. */
export class GeminiQuotaError extends Error {
  override readonly name = "GeminiQuotaError";
  constructor(message: string, readonly resetAt: number | null) {
    super(message);
  }
}

/** A refusal's text as the plan words it ("Individual quota reached", RESOURCE_EXHAUSTED, ...). */
export function isGeminiQuotaText(text: string): boolean {
  return /quota|resource.?exhausted|rate.?limit|usage limit|exhausted your capacity|limit (?:reached|exceeded)|\b429\b|out of credits/i.test(text);
}

/** "Resets in 4h16m56s", "reset after 45s": the wait it names, in ms. */
export function geminiResetIn(text: string): number | null {
  const match = /\bresets?\s+(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:ms|d|h|m|s)\s*)+)/i.exec(text);
  if (!match) return null;
  const unit: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  let total = 0;
  for (const part of match[1].matchAll(/(\d+(?:\.\d+)?)\s*(ms|d|h|m|s)/gi)) total += Number(part[1]) * unit[part[2].toLowerCase()];
  return total > 0 ? Math.round(total) : null;
}

/** The refusal `message` (the CLI's own words) as the error the usage-limit wait acts on. */
export function geminiQuotaError(message: string, now = Date.now()): GeminiQuotaError {
  const resetIn = geminiResetIn(message);
  return new GeminiQuotaError(`Gemini usage limit reached on the Google AI plan: ${message}`, resetIn === null ? null : now + resetIn);
}

function refusalPath(): string {
  return join(dataDir(), REFUSAL_FILE);
}

function saveRefusal(): void {
  try {
    if (!refusal) {
      rmSync(refusalPath(), { force: true });
      return;
    }
    mkdirSync(dataDir(), { recursive: true });
    const tmp = `${refusalPath()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(refusal));
    renameSync(tmp, refusalPath());
  } catch (error) {
    log("warn", `gemini usage: could not save the quota refusal: ${error instanceof Error ? error.message : error}`);
  }
}

/** The refusal in force at `now`, read from disk after a restart. */
function activeRefusal(now: number): GeminiQuotaRefusal | null {
  if (refusal === undefined) {
    refusal = null;
    try {
      if (existsSync(refusalPath())) {
        const parsed = JSON.parse(readFileSync(refusalPath(), "utf8")) as Partial<GeminiQuotaRefusal>;
        if (typeof parsed.until === "number") {
          refusal = { argon: parsed.argon === true, resetAt: typeof parsed.resetAt === "number" ? parsed.resetAt : null, until: parsed.until };
        }
      }
    } catch (error) {
      log("warn", `gemini usage: could not read ${refusalPath()}: ${error instanceof Error ? error.message : error}`);
    }
  }
  if (refusal && refusal.until <= now) {
    refusal = null;
    saveRefusal();
  }
  return refusal;
}

/**
 * The plan refused a turn on `model`, saying it resets at `resetAt` (null:
 * it did not say). Holds Gemini turns until then and shows it at once; then
 * reads `/usage` again (`refresh`), the CLI's only machine-readable quota.
 */
export function noteGeminiQuotaRefusal(model: string | null, resetAt: number | null, options: { now?: number; refresh?: boolean } = {}): void {
  const now = options.now ?? Date.now();
  refusal = { argon: !!model?.includes("argon"), resetAt, until: resetAt ?? now + UNKNOWN_RESET_RECHECK_MS };
  saveRefusal();
  log("info", `gemini usage: the plan refused a ${model ?? "Gemini"} request; ${resetAt ? `it resets ${new Date(resetAt).toISOString()}` : "no reset time given, checking again in a minute"}`);
  usageListener?.(getLastUsage());
  if (options.refresh === false) return;
  void readGeminiQuota(true).then(() => usageListener?.(getLastUsage())).catch(() => {});
}

function windowSpent(window: UsageWindow | null, now: number): boolean {
  return !!window && window.utilization >= 100 && (window.resetsAt === null || window.resetsAt > now);
}

/**
 * The last screen read with the refusal in force laid over it: the refused
 * group's window whose reset is nearest the refusal's (the five-hour one when
 * it gave none) is spent until the later of the two resets.
 */
function effectiveReport(now = Date.now()): GeminiQuotaReport | null {
  const held = activeRefusal(now);
  if (!held) return lastReport;
  const base: GeminiQuotaReport = lastReport ?? { account: null, groups: [{ name: "GEMINI MODELS", weekly: null, fiveHour: null }] };
  const argon = held.argon ? base.groups.find(g => /ARGON/i.test(g.name)) : undefined;
  const target = argon ?? sharedGroup(base);
  if (!target) return lastReport;
  const kinds = (["fiveHour", "weekly"] as const).filter(kind => target[kind]);
  let kind: "fiveHour" | "weekly" = kinds.find(k => windowSpent(target[k], now)) ?? "fiveHour";
  if (!kinds.some(k => windowSpent(target[k], now)) && held.resetAt !== null) {
    const dated = kinds.filter(k => target[k]!.resetsAt !== null);
    if (dated.length > 0) kind = dated.reduce((a, b) => Math.abs(target[a]!.resetsAt! - held.resetAt!) <= Math.abs(target[b]!.resetsAt! - held.resetAt!) ? a : b);
  }
  const current = target[kind];
  const known = [windowSpent(current, now) ? current!.resetsAt : null, held.resetAt].filter((at): at is number => at !== null);
  const resetsAt = known.length > 0 ? Math.max(...known) : null;
  const spent: GeminiQuotaGroup = { ...target, [kind]: { utilization: 100, resetsAt } };
  return { ...base, groups: base.groups.map(group => group === target ? spent : group) };
}

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
  const started = generation;
  // Set before the read's finally runs (after its first await).
  let read: Promise<GeminiQuotaReport | null> | undefined;
  read = (async () => {
    try {
      const report = parseUsageScreen(await readUsageScreen());
      if (started !== generation) return null;
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
      if (started === generation) lastReadAt = Date.now();
      return null;
    } finally {
      if (inflight === read) inflight = null;
    }
  })();
  inflight = read;
  return inflight;
}

export function lastGeminiQuota(): GeminiQuotaReport | null {
  return effectiveReport();
}

/** When `/usage` was last read successfully; 0 before. */
export function lastGeminiQuotaReadAt(): number {
  return lastReport ? lastReportAt : 0;
}

export function getLastUsage(): UsageData | null {
  const report = effectiveReport();
  return report && report !== lastReport ? usageFromReport(report) : lastUsage;
}

/** The last read at once; refreshRemoteUsage reads again when it is a few minutes old. */
export function refreshUsage(onUpdate: (usage: UsageData | null) => void): void {
  onUpdate(getLastUsage());
}

export async function refreshRemoteUsage(): Promise<UsageData | null> {
  await readGeminiQuota();
  return getLastUsage();
}

export function handleUsageHeaders(_headers: Headers, _onUpdate: (usage: UsageData) => void): void {
  // The CLI talks to Google itself: no response headers reach Exocortex.
}

export function clearUsage(): void {
  generation++;
  inflight = null;
  lastUsage = null;
  lastReport = null;
  lastReadAt = 0;
  lastReportAt = 0;
  refusal = null;
  saveRefusal();
}

/**
 * Whether a turn on `model` can run now by the last quota read, for the
 * orchestrator's usage-limit wait. Argon follows a group of its own when the
 * screen lists one, else the shared Gemini group.
 */
export function geminiUsageAvailability(model: string | null, now = Date.now()): { ready: boolean; resetAt: number | null } {
  const report = effectiveReport(now);
  if (!report) return { ready: true, resetAt: null };
  // Argon had a weekly limit of its own on Pro; since CLI 1.5.16 it shares the Gemini group.
  const argon = model?.includes("argon") ? report.groups.find(g => /ARGON/i.test(g.name)) : undefined;
  const group = argon ?? sharedGroup(report);
  if (!group) return { ready: true, resetAt: null };
  const spent = [group.fiveHour, group.weekly].filter((w): w is UsageWindow => windowSpent(w, now));
  if (spent.length === 0) return { ready: true, resetAt: null };
  const resets = spent.map(w => w.resetsAt).filter((at): at is number => at !== null);
  return { ready: false, resetAt: resets.length ? Math.max(...resets) : null };
}

/** For tests: forget the refusal in memory, as a restart does, so the next check reads it from disk. */
export function reloadGeminiQuotaRefusalForTest(): void {
  refusal = undefined;
}

/** For tests. */
export function setGeminiQuotaForTest(report: GeminiQuotaReport | null): void {
  lastReport = report;
  lastUsage = report ? usageFromReport(report) : null;
  lastReadAt = lastReportAt = report ? Date.now() : 0;
}
