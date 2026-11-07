import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "./handler";
import {
  cpuPercent,
  createLinuxSource,
  createMacSource,
  createMachineResourcesWatch,
  createVmStatParser,
  findAmdGpuDevice,
  parseMeminfo,
  parseProcStat,
  setMachineResourcesTimingForTest,
  sumCpuInfo,
  type ResourceSource,
} from "./machine-resources";
import type { MachineResources } from "./protocol";

const PROC_STAT_1 = `cpu  27941553 43282734 22237970 317208678 4042657 2138835 2113041 0 0 0
cpu0 2328463 3606894 1853164 26434056 336888 178236 176086 0 0 0
intr 123
`;
// +300 user, +100 nice, +100 system, +400 idle, +100 iowait over the interval.
const PROC_STAT_2 = `cpu  27941853 43282834 22238070 317209078 4042757 2138835 2113041 0 0 0
cpu0 2328463 3606894 1853164 26434056 336888 178236 176086 0 0 0
`;

const MEMINFO = `MemTotal:       32762744 kB
MemFree:         1048576 kB
MemAvailable:   22359344 kB
Buffers:          123456 kB
`;

const VM_STAT_INTERVAL = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
    free   active   specul inactive throttle    wired  prgable   faults     copy    0fill reactive   purged file-backed anonymous cmprssed cmprssor  dcomprs   comprs  pageins  pageout  swapins swapouts
    5853   536906      279   535866        0   259305    30518   30897M 2936966K 9685533K 3036369K 1329331K      392022    681029   949542   178562 3645233K 3953429K  493104K 14007827 10894767 14042910
    4208   548354      328   547607        0   237755    38185    24079     2595     8069        0        0      392108    704181   949541   178562        1        0       90        0        0        0
`;

const GIB = 1024 ** 3;

describe("parsing", () => {
  test("/proc/stat: idle and iowait are idle, everything else is busy", () => {
    const first = parseProcStat(PROC_STAT_1)!;
    const second = parseProcStat(PROC_STAT_2)!;
    expect(second.total - first.total).toBe(1000);
    expect(cpuPercent(first, second)).toBe(50);
    expect(cpuPercent(null, second)).toBeNull();
    expect(cpuPercent(second, second)).toBeNull();
    expect(parseProcStat("intr 1 2 3\n")).toBeNull();
  });

  test("/proc/meminfo: used is MemTotal − MemAvailable", () => {
    expect(parseMeminfo(MEMINFO)).toEqual({ usedBytes: (32762744 - 22359344) * 1024, totalBytes: 32762744 * 1024 });
    expect(parseMeminfo("MemTotal: 100 kB\n")).toBeNull();
  });

  test("os.cpus(): every core's busy share", () => {
    const at = (user: number, idle: number) => [
      { times: { user, nice: 0, sys: 10, idle, irq: 0 } },
      { times: { user, nice: 0, sys: 10, idle, irq: 0 } },
    ];
    expect(cpuPercent(sumCpuInfo(at(0, 0)), sumCpuInfo(at(30, 10)))).toBe(75);
    expect(sumCpuInfo([])).toBeNull();
  });

  test("vm_stat interval rows: app memory + wired + compressed, in the page size it states", () => {
    const parse = createVmStatParser(24 * GIB);
    const readings = VM_STAT_INTERVAL.split("\n").map(parse);
    expect(readings[0]).toBeNull();
    expect(readings[1]).toBeNull();
    expect(readings[2]).toEqual({ usedBytes: (681029 - 30518 + 259305 + 178562) * 16384, totalBytes: 24 * GIB });
    expect(readings[3]).toEqual({ usedBytes: (704181 - 38185 + 237755 + 178562) * 16384, totalBytes: 24 * GIB });
    // A row before its header, or a short one, says nothing.
    expect(createVmStatParser(GIB)("    4208   548354")).toBeNull();
  });
});

function fixtureDir(): string {
  return mkdtempSync(join(tmpdir(), "exo-machine-resources-"));
}

function writeAll(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

describe("Linux source", () => {
  test("reads /proc and the amdgpu card with the most VRAM", () => {
    const root = fixtureDir();
    try {
      writeAll(root, {
        "proc/stat": PROC_STAT_1,
        "proc/meminfo": MEMINFO,
        "drm/card0/device/gpu_busy_percent": "3\n",
        "drm/card0/device/mem_info_vram_total": "536870912\n",
        "drm/card1/device/gpu_busy_percent": "42\n",
        "drm/card1/device/mem_info_vram_used": "356016128\n",
        "drm/card1/device/mem_info_vram_total": "8573157376\n",
        "drm/card1-DP-1/status": "connected\n",
      });
      expect(findAmdGpuDevice(join(root, "drm"))).toBe(join(root, "drm/card1/device"));
      const source = createLinuxSource({ procDir: join(root, "proc"), drmDir: join(root, "drm"), now: () => 7 });
      writeFileSync(join(root, "proc/stat"), PROC_STAT_2);
      expect(source.sample()).toEqual({
        cpuPercent: 50,
        memory: { usedBytes: (32762744 - 22359344) * 1024, totalBytes: 32762744 * 1024 },
        gpuPercent: 42,
        vram: { usedBytes: 356016128, totalBytes: 8573157376 },
        sampledAt: 7,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a machine without a GPU or /proc reports nulls", () => {
    const root = fixtureDir();
    try {
      const source = createLinuxSource({ procDir: join(root, "proc"), drmDir: join(root, "drm"), now: () => 1 });
      expect(source.sample()).toEqual({ cpuPercent: null, memory: null, gpuPercent: null, vram: null, sampledAt: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("macOS source", () => {
  test("CPU from os.cpus(), memory from one vm_stat, no GPU", () => {
    let user = 0;
    let lineSink: ((line: string) => void) | null = null;
    let exit: (() => void) | null = null;
    const startVmStat = mock((seconds: number, onLine: (line: string) => void, onExit: () => void) => {
      expect(seconds).toBe(2);
      lineSink = onLine;
      exit = onExit;
      return stop;
    });
    const stop = mock(() => {});
    let clock = 1_000;
    const source = createMacSource({
      cpuInfo: () => [{ model: "", speed: 0, times: { user, nice: 0, sys: 0, idle: 100 - user + (user ? 100 : 0), irq: 0 } }],
      totalBytes: 24 * GIB,
      startVmStat,
      now: () => clock,
    });
    for (const line of VM_STAT_INTERVAL.split("\n").slice(0, 3)) lineSink!(line);
    // The instant first sample: memory, no CPU, and the CPU baseline kept.
    const instant = source.sample(false);
    expect(instant.cpuPercent).toBeNull();
    expect(instant.memory).not.toBeNull();
    user = 25;
    const sample = source.sample();
    expect(sample.cpuPercent).toBe(25);
    expect(sample.memory?.usedBytes).toBe((681029 - 30518 + 259305 + 178562) * 16384);
    expect(sample.gpuPercent).toBeNull();
    expect(sample.vram).toBeNull();
    expect(startVmStat).toHaveBeenCalledTimes(1);

    // vm_stat died: memory is unknown, and it starts again only after a while.
    exit!();
    expect(source.sample().memory).toBeNull();
    expect(startVmStat).toHaveBeenCalledTimes(1);
    clock += 60_000;
    source.sample();
    expect(startVmStat).toHaveBeenCalledTimes(2);
    source.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

const SNAPSHOT: MachineResources = { cpuPercent: 12.5, memory: null, gpuPercent: null, vram: null, sampledAt: 1 };

function fakeClient(id: string) {
  return { id, socket: { destroyed: false } } as never as Parameters<ReturnType<typeof createMachineResourcesWatch>["add"]>[0];
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !done(); i++) await Bun.sleep(2);
  expect(done()).toBe(true);
}

describe("watch", () => {
  function watchHarness(graceMs: number) {
    const sent: Array<{ client: string; resources: MachineResources }> = [];
    const samples: boolean[] = [];
    let created = 0;
    let stopped = 0;
    let clock = 1_000;
    const watch = createMachineResourcesWatch({
      send: (client, event) => {
        if (event.type === "machine_resources") sent.push({ client: (client as { id: string }).id, resources: event.resources });
      },
      createSource: (): ResourceSource => {
        created++;
        return {
          sample: (withCpu = true) => {
            samples.push(withCpu);
            return { ...SNAPSHOT, cpuPercent: withCpu ? SNAPSHOT.cpuPercent : null };
          },
          stop: () => { stopped++; },
        };
      },
      intervalMs: 5,
      firstSampleMs: 1,
      graceMs,
      now: () => clock,
    });
    return { watch, sent, samples, created: () => created, stopped: () => stopped, advance: (ms: number) => { clock += ms; } };
  }

  test("a new watcher gets a sample at once: instant figures first, CPU in the next", async () => {
    const h = watchHarness(0);
    const a = fakeClient("a");
    expect(h.watch.sampling()).toBe(false);
    h.watch.add(a);
    // Sent while handling the subscription, before anything else goes out.
    expect(h.sent).toEqual([{ client: "a", resources: { ...SNAPSHOT, cpuPercent: null } }]);
    expect(h.samples).toEqual([false]);
    await until(() => h.sent.length >= 2);
    expect(h.sent[1].resources.cpuPercent).toBe(12.5);
    h.watch.dispose();
  });

  test("a late joiner gets the last sample at once; sampling stops a grace period after the last leaves", async () => {
    const h = watchHarness(30_000);
    const a = fakeClient("a");
    const b = fakeClient("b");
    h.watch.add(a);
    await until(() => h.sent.length >= 2);

    h.sent.length = 0;
    h.watch.add(b);
    expect(h.sent).toEqual([{ client: "b", resources: SNAPSHOT }]);
    h.watch.add(b);
    expect(h.sent).toHaveLength(1);

    h.watch.remove(a);
    h.watch.remove(b);
    // Within the grace period: still sampling, and a reopened TUI gets a full sample at once.
    const before = h.samples.length;
    await until(() => h.samples.length > before + 1);
    expect(h.watch.sampling()).toBe(true);
    h.sent.length = 0;
    const c = fakeClient("c");
    h.watch.add(c);
    expect(h.sent).toEqual([{ client: "c", resources: SNAPSHOT }]);
    h.watch.remove(c);

    h.advance(30_000);
    await until(() => !h.watch.sampling());
    expect(h.stopped()).toBe(1);
    expect(h.created()).toBe(1);
    h.watch.dispose();
  });

  test("a disconnected watcher is dropped at the next sample", async () => {
    const h = watchHarness(0);
    const a = fakeClient("a") as unknown as { socket: { destroyed: boolean } };
    h.watch.add(a as never);
    a.socket.destroyed = true;
    await until(() => !h.watch.sampling());
    expect(h.watch.watcherCount()).toBe(0);
  });
});

describe("handler", () => {
  afterEach(() => setMachineResourcesTimingForTest());

  function harness() {
    const sent: Array<{ client: unknown; event: any }> = [];
    const server = {
      sendTo: mock((client: unknown, event: unknown) => { sent.push({ client, event }); }),
      broadcast: mock(() => {}), sendToSubscribers: mock(() => {}), sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}), unsubscribe: mock(() => {}), hasSubscribers: mock(() => false), broadcastHistoryRevisions: mock(() => {}),
    };
    const handle = createHandler(server as never);
    const client = { id: "tui", capabilities: new Set<string>(), subscriptions: new Set<string>(), socket: { destroyed: false } };
    const resources = () => sent.filter(entry => entry.event.type === "machine_resources");
    const stop = () => (handle as unknown as { stop: () => Promise<void> }).stop();
    return { handle, client, sent, resources, stop };
  }

  test("a machine-resources client gets a sample in the capabilities' own handling, CPU within ~300 ms, until it disconnects", async () => {
    setMachineResourcesTimingForTest({ intervalMs: 2_000, firstSampleMs: 200, graceMs: 0 });
    const h = harness();
    try {
      const startedAt = performance.now();
      await h.handle(h.client as never, { type: "client_capabilities", capabilities: ["machine-resources"] });
      expect(h.client.capabilities.has("machine-resources")).toBe(true);
      expect(h.resources()).toHaveLength(1);
      const first = h.resources()[0].event.resources as MachineResources;
      expect(first.cpuPercent).toBeNull();
      if (process.platform === "linux") expect(first.memory?.totalBytes).toBeGreaterThan(0);

      await until(() => h.resources().length >= 2);
      expect(performance.now() - startedAt).toBeLessThan(400);
      if (process.platform === "linux") expect(h.resources()[1].event.resources.cpuPercent).not.toBeNull();

      // A second declaration (the /ssh probe's, then the connection's) sends nothing more.
      await h.handle(h.client as never, { type: "client_capabilities", capabilities: ["machine-resources"] });
      expect(h.resources()).toHaveLength(2);
    } finally {
      await h.stop();
    }
  });

  test("a client without the capability gets none", async () => {
    setMachineResourcesTimingForTest({ intervalMs: 5, firstSampleMs: 1, graceMs: 0 });
    const h = harness();
    try {
      await h.handle(h.client as never, { type: "client_capabilities", capabilities: ["history-push"] });
      await Bun.sleep(20);
      expect(h.resources()).toEqual([]);
    } finally {
      await h.stop();
    }
  });
});
