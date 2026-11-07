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
  test("samples only while a client watches, and gives a late joiner the last sample at once", async () => {
    const sent: Array<{ client: string; resources: MachineResources }> = [];
    const stops: number[] = [];
    let created = 0;
    const watch = createMachineResourcesWatch({
      send: (client, event) => {
        if (event.type === "machine_resources") sent.push({ client: (client as { id: string }).id, resources: event.resources });
      },
      createSource: (): ResourceSource => {
        created++;
        return { sample: () => SNAPSHOT, stop: () => { stops.push(created); } };
      },
      intervalMs: 5,
      firstSampleMs: 1,
    });
    const a = fakeClient("a");
    const b = fakeClient("b");
    expect(watch.sampling()).toBe(false);
    watch.add(a);
    expect(watch.sampling()).toBe(true);
    await until(() => sent.length >= 2);
    expect(sent.every(entry => entry.client === "a" && entry.resources === SNAPSHOT)).toBe(true);

    sent.length = 0;
    watch.add(b);
    expect(sent).toEqual([{ client: "b", resources: SNAPSHOT }]);
    watch.add(b);
    expect(sent).toHaveLength(1);

    watch.remove(a);
    expect(watch.sampling()).toBe(true);
    watch.remove(b);
    expect(watch.sampling()).toBe(false);
    expect(stops).toEqual([1]);
    expect(created).toBe(1);
    watch.dispose();
  });
});

describe("handler", () => {
  afterEach(() => setMachineResourcesTimingForTest());

  function harness(capabilities: string[]) {
    setMachineResourcesTimingForTest({ intervalMs: 5, firstSampleMs: 1 });
    const sent: Array<{ client: unknown; event: any }> = [];
    const server = {
      sendTo: mock((client: unknown, event: unknown) => { sent.push({ client, event }); }),
      broadcast: mock(() => {}), sendToSubscribers: mock(() => {}), sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}), unsubscribe: mock(() => {}), hasSubscribers: mock(() => false), broadcastHistoryRevisions: mock(() => {}),
    };
    const handle = createHandler(server as never);
    const client = { id: "tui", capabilities: new Set<string>(), subscriptions: new Set<string>(), socket: { destroyed: false } };
    const resources = () => sent.filter(entry => entry.event.type === "machine_resources");
    return { handle, client, sent, resources, close: () => { client.socket.destroyed = true; }, capabilities };
  }

  test("a machine-resources client gets this machine's samples until it disconnects", async () => {
    const h = harness(["machine-resources"]);
    try {
      await h.handle(h.client as never, { type: "client_capabilities", capabilities: ["machine-resources"] });
      expect(h.client.capabilities.has("machine-resources")).toBe(true);
      await until(() => h.resources().length >= 2);
      const { event } = h.resources().at(-1)!;
      expect(event.resources.sampledAt).toBeGreaterThan(0);
      if (process.platform === "linux") expect(event.resources.memory?.totalBytes).toBeGreaterThan(0);
      h.close();
      const count = h.resources().length;
      await Bun.sleep(20);
      expect(h.resources().length).toBe(count);
    } finally {
      await (h.handle as unknown as { stop: () => Promise<void> }).stop();
    }
  });

  test("a client without the capability gets none", async () => {
    const h = harness([]);
    try {
      await h.handle(h.client as never, { type: "client_capabilities", capabilities: ["history-push"] });
      await Bun.sleep(20);
      expect(h.resources()).toEqual([]);
    } finally {
      await (h.handle as unknown as { stop: () => Promise<void> }).stop();
    }
  });
});
