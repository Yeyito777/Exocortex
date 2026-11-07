/**
 * The status bar's resources block: what this daemon's machine is using (CPU,
 * RAM, GPU, VRAM), pushed every few seconds to clients that declare the
 * machine-resources capability. A TUI on /ssh talks to the remote daemon, so
 * it shows the remote's machine.
 *
 * A client gets a sample as soon as it declares the capability (the last one,
 * or memory and GPU figures read at once with CPU to follow ~200 ms later).
 * Sampling runs only while such a client is connected and for 30 s after the
 * last one leaves, and never starts a process per tick:
 * - Linux: /proc/stat, /proc/meminfo and an amdgpu card's sysfs files
 *   (gpu_busy_percent, the figure radeontop reports, and mem_info_vram_*).
 * - macOS: os.cpus() (host_processor_info) for CPU, one long-running
 *   `vm_stat <seconds>` for memory (Activity Monitor's "Memory Used": app
 *   memory + wired + compressed). The GPU's busy share needs root there and
 *   its memory is the system's, so both are null.
 */

import { spawn } from "child_process";
import { readdirSync, readFileSync } from "fs";
import { cpus, totalmem } from "os";
import { join } from "path";
import type { Event, MachineResources, MemoryUse } from "./protocol";
import type { ConnectedClient } from "./server";
import { log } from "./log";

/** How often a sample goes out while watched. */
const SAMPLE_INTERVAL_MS = 2_000;
/** The first full sample after sampling starts: soon, but long enough for a CPU reading. */
const FIRST_SAMPLE_MS = 200;
/** Sampling goes on this long after the last watcher leaves, so a TUI reopened meanwhile gets a sample at once. */
const IDLE_GRACE_MS = 30_000;
const DEFAULT_TIMING = { intervalMs: SAMPLE_INTERVAL_MS, firstSampleMs: FIRST_SAMPLE_MS, graceMs: IDLE_GRACE_MS };
let timing = DEFAULT_TIMING;

/** Shrink the watch's waits in tests; call with no argument to restore them. */
export function setMachineResourcesTimingForTest(next?: typeof DEFAULT_TIMING): void {
  timing = next ?? DEFAULT_TIMING;
}
/** A vm_stat that exited is started again no sooner than this. */
const VM_STAT_RESPAWN_MS = 30_000;

// ── Parsing ─────────────────────────────────────────────────────────

/** Cumulative CPU time: `busy` of `total`, in any unit. */
export interface CpuTimes {
  busy: number;
  total: number;
}

/** The aggregate "cpu" line of /proc/stat; idle and iowait are not busy. */
export function parseProcStat(text: string): CpuTimes | null {
  const line = text.split("\n", 1)[0] ?? "";
  const fields = line.trim().split(/\s+/);
  if (fields[0] !== "cpu" || fields.length < 5) return null;
  // user nice system idle iowait irq softirq steal (guest time is already in user/nice).
  const values = fields.slice(1, 9).map(Number);
  if (values.some(value => !Number.isFinite(value))) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  const idle = values[3] + (values[4] ?? 0);
  return { busy: total - idle, total };
}

/** Every core's times from os.cpus(). */
export function sumCpuInfo(infos: readonly { times: { user: number; nice: number; sys: number; idle: number; irq: number } }[]): CpuTimes | null {
  if (infos.length === 0) return null;
  let busy = 0;
  let total = 0;
  for (const { times } of infos) {
    const coreBusy = times.user + times.nice + times.sys + times.irq;
    busy += coreBusy;
    total += coreBusy + times.idle;
  }
  return { busy, total };
}

/** Busy share between two readings, 0–100 with one decimal; null without an interval. */
export function cpuPercent(previous: CpuTimes | null, next: CpuTimes | null): number | null {
  if (!previous || !next) return null;
  const total = next.total - previous.total;
  if (total <= 0) return null;
  const busy = Math.max(0, Math.min(total, next.busy - previous.busy));
  return Math.round((busy / total) * 1000) / 10;
}

/** MemTotal − MemAvailable from /proc/meminfo (what `free` calls used). */
export function parseMeminfo(text: string): MemoryUse | null {
  const kib = (name: string): number | null => {
    const match = new RegExp(`^${name}:\\s+(\\d+) kB`, "m").exec(text);
    return match ? Number(match[1]) * 1024 : null;
  };
  const total = kib("MemTotal");
  const available = kib("MemAvailable");
  if (!total || available === null) return null;
  return { usedBytes: Math.max(0, total - available), totalBytes: total };
}

/** A sysfs number file's value. */
function parseInteger(text: string | null): number | null {
  if (text === null) return null;
  const value = Number(text.trim());
  return text.trim() !== "" && Number.isFinite(value) ? value : null;
}

/** vm_stat abbreviates numbers wider than their column: 30897M. */
function parseVmStatCount(text: string): number | null {
  const match = /^(\d+)([KMG]?)$/.exec(text);
  if (!match) return null;
  return Number(match[1]) * ({ "": 1, K: 1e3, M: 1e6, G: 1e9 } as const)[match[2] as "" | "K" | "M" | "G"];
}

/**
 * Reads `vm_stat <seconds>` line by line; a data row gives the memory in use:
 * anonymous pages that are not purgeable (app memory), wired, and the pages
 * the compressor occupies.
 */
export function createVmStatParser(totalBytes: number): (line: string) => MemoryUse | null {
  let pageSize = 4096;
  let columns: string[] | null = null;
  return (line) => {
    const size = /page size of (\d+) bytes/.exec(line);
    if (size) {
      pageSize = Number(size[1]);
      return null;
    }
    const fields = line.trim().split(/\s+/);
    if (fields.includes("free") && fields.includes("anonymous")) {
      columns = fields;
      return null;
    }
    if (!columns || fields.length !== columns.length) return null;
    const pages = (name: string): number | null => {
      const index = columns!.indexOf(name);
      return index < 0 ? null : parseVmStatCount(fields[index]);
    };
    const anonymous = pages("anonymous");
    const purgeable = pages("prgable") ?? 0;
    const wired = pages("wired");
    const compressor = pages("cmprssor") ?? 0;
    if (anonymous === null || wired === null || totalBytes <= 0) return null;
    const used = (Math.max(0, anonymous - purgeable) + wired + compressor) * pageSize;
    return { usedBytes: Math.min(used, totalBytes), totalBytes };
  };
}

// ── Sources ─────────────────────────────────────────────────────────

/**
 * One machine's readings; CPU is measured since the previous sample that
 * measured it. Without `withCpu` (the instant first sample), CPU is null.
 */
export interface ResourceSource {
  sample(withCpu?: boolean): MachineResources;
  stop(): void;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The amdgpu card's device directory with the most VRAM, or null. */
export function findAmdGpuDevice(drmDir = "/sys/class/drm", read: (path: string) => string | null = readText): string | null {
  let names: string[];
  try {
    names = readdirSync(drmDir).filter(name => /^card\d+$/.test(name));
  } catch {
    return null;
  }
  let best: { device: string; vram: number } | null = null;
  for (const name of names) {
    const device = join(drmDir, name, "device");
    const busy = parseInteger(read(join(device, "gpu_busy_percent")));
    const vram = parseInteger(read(join(device, "mem_info_vram_total"))) ?? 0;
    if (busy === null && vram === 0) continue;
    if (!best || vram > best.vram) best = { device, vram };
  }
  return best?.device ?? null;
}

export interface LinuxSourceOptions {
  procDir?: string;
  drmDir?: string;
  read?: (path: string) => string | null;
  now?: () => number;
}

export function createLinuxSource(options: LinuxSourceOptions = {}): ResourceSource {
  const procDir = options.procDir ?? "/proc";
  const read = options.read ?? readText;
  const now = options.now ?? Date.now;
  const gpu = findAmdGpuDevice(options.drmDir, read);
  const readCpu = () => parseProcStat(read(join(procDir, "stat")) ?? "");
  let previous = readCpu();
  return {
    sample(withCpu = true) {
      let cpu: number | null = null;
      if (withCpu) {
        const next = readCpu();
        cpu = cpuPercent(previous, next);
        if (next) previous = next;
      }
      const vramUsed = gpu ? parseInteger(read(join(gpu, "mem_info_vram_used"))) : null;
      const vramTotal = gpu ? parseInteger(read(join(gpu, "mem_info_vram_total"))) : null;
      const busy = gpu ? parseInteger(read(join(gpu, "gpu_busy_percent"))) : null;
      return {
        cpuPercent: cpu,
        memory: parseMeminfo(read(join(procDir, "meminfo")) ?? ""),
        gpuPercent: busy === null ? null : Math.max(0, Math.min(100, busy)),
        vram: vramUsed !== null && vramTotal ? { usedBytes: vramUsed, totalBytes: vramTotal } : null,
        sampledAt: now(),
      };
    },
    stop() {},
  };
}

export interface MacSourceOptions {
  cpuInfo?: () => ReturnType<typeof cpus>;
  totalBytes?: number;
  /** Starts `vm_stat <seconds>`, feeding each line of its output; returns its stop. `onExit` follows its end. */
  startVmStat?: (seconds: number, onLine: (line: string) => void, onExit: () => void) => () => void;
  now?: () => number;
}

function spawnVmStat(seconds: number, onLine: (line: string) => void, onExit: () => void): () => void {
  const child = spawn("vm_stat", [String(seconds)], { stdio: ["ignore", "pipe", "ignore"] });
  let buffered = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffered += chunk;
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      onLine(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
    }
  });
  child.on("error", (error) => log("debug", `machine resources: vm_stat failed: ${error.message}`));
  child.on("close", onExit);
  return () => { child.kill(); };
}

export function createMacSource(options: MacSourceOptions = {}): ResourceSource {
  const cpuInfo = options.cpuInfo ?? cpus;
  const totalBytes = options.totalBytes ?? totalmem();
  const startVmStat = options.startVmStat ?? spawnVmStat;
  const now = options.now ?? Date.now;
  let previous = sumCpuInfo(cpuInfo());
  let memory: MemoryUse | null = null;
  let stopVmStat: (() => void) | null = null;
  let startedAt = 0;
  let stopped = false;

  const ensureVmStat = () => {
    if (stopVmStat || stopped || (startedAt && now() - startedAt < VM_STAT_RESPAWN_MS)) return;
    startedAt = now();
    const parse = createVmStatParser(totalBytes);
    let stop: (() => void) | null = null;
    stop = startVmStat(SAMPLE_INTERVAL_MS / 1000, (line) => {
      const reading = parse(line);
      if (reading) memory = reading;
    }, () => {
      if (stopVmStat === stop) stopVmStat = null;
      memory = null;
    });
    stopVmStat = stop;
  };
  ensureVmStat();

  return {
    sample(withCpu = true) {
      ensureVmStat();
      let cpu: number | null = null;
      if (withCpu) {
        const next = sumCpuInfo(cpuInfo());
        cpu = cpuPercent(previous, next);
        if (next) previous = next;
      }
      return { cpuPercent: cpu, memory, gpuPercent: null, vram: null, sampledAt: now() };
    },
    stop() {
      stopped = true;
      stopVmStat?.();
      stopVmStat = null;
    },
  };
}

function defaultSource(): ResourceSource {
  return process.platform === "darwin" ? createMacSource() : createLinuxSource();
}

// ── Watchers ────────────────────────────────────────────────────────

export interface MachineResourcesWatchDeps {
  send: (client: ConnectedClient, event: Event) => void;
  createSource?: () => ResourceSource;
  intervalMs?: number;
  firstSampleMs?: number;
  graceMs?: number;
  now?: () => number;
}

export function createMachineResourcesWatch(deps: MachineResourcesWatchDeps) {
  const createSource = deps.createSource ?? defaultSource;
  const intervalMs = deps.intervalMs ?? timing.intervalMs;
  const firstSampleMs = deps.firstSampleMs ?? timing.firstSampleMs;
  const graceMs = deps.graceMs ?? timing.graceMs;
  const now = deps.now ?? Date.now;
  const watchers = new Set<ConnectedClient>();
  let source: ResourceSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: MachineResources | null = null;
  /** When a client last watched (sampling stops `graceMs` after). */
  let watchedAt = 0;

  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    source?.stop();
    source = null;
    latest = null;
  };

  const schedule = (delay: number) => {
    timer = setTimeout(tick, delay);
    (timer as { unref?: () => void }).unref?.();
  };

  const tick = () => {
    timer = null;
    if (!source) return;
    try {
      latest = source.sample();
    } catch (error) {
      log("debug", `machine resources: sample failed: ${error instanceof Error ? error.message : error}`);
    }
    if (latest) {
      const event: Event = { type: "machine_resources", resources: latest };
      for (const client of watchers) {
        if (client.socket.destroyed) watchers.delete(client);
        else deps.send(client, event);
      }
    }
    if (watchers.size > 0) watchedAt = now();
    if (watchers.size === 0 && now() - watchedAt >= graceMs) stop();
    else schedule(intervalMs);
  };

  return {
    add(client: ConnectedClient): void {
      if (watchers.has(client)) return;
      watchers.add(client);
      watchedAt = now();
      if (!source) {
        try {
          source = createSource();
          // Memory and the GPU's figures are instant reads; CPU follows in the first full sample.
          latest = source.sample(false);
        } catch (error) {
          log("debug", `machine resources: unavailable: ${error instanceof Error ? error.message : error}`);
          stop();
          return;
        }
        schedule(firstSampleMs);
      }
      // At once, in the command's own handling: the TUI tells from it, ahead of
      // the bootstrap, that this daemon sends them.
      if (latest) deps.send(client, { type: "machine_resources", resources: latest });
    },
    remove(client: ConnectedClient): void {
      if (watchers.delete(client) && watchers.size === 0) watchedAt = now();
    },
    /** Stop sampling for good (daemon shutdown). */
    dispose(): void {
      watchers.clear();
      stop();
    },
    watcherCount: () => watchers.size,
    sampling: () => source !== null,
  };
}
