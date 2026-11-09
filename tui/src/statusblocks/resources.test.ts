import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleEvent, type DaemonActions } from "../events";
import { stripAnsi } from "../historycursor";
import { DEFAULT_RESOURCES_SHAPE, machineResourcesDisconnected, machineResourcesRouteSwitched, ResourcesShapes, shapeAfter, type ResourcesShape } from "../machine-resources";
import type { Event, MachineResources } from "../protocol";
import { createInitialState } from "../state";
import { renderStatusLine } from "../statusline";
import { theme } from "../theme";
import { contextBlock } from "./context";
import { formatMemory, formatPercent, resolveResourcesGpuSetting, resourcesBlock, resourcesBlockFor, setResourcesGpuEnabled } from "./resources";
import { usageBlock } from "./usage";

const GIB = 1024 ** 3;

/** whale: 12 cores, 31 GiB, an 8 GiB Radeon. */
const WHALE: MachineResources = {
  cpuPercent: 64,
  memory: { usedBytes: 10.8 * GIB, totalBytes: 32762744 * 1024 },
  gpuPercent: 0,
  vram: { usedBytes: 356016128, totalBytes: 8573157376 },
  sampledAt: 1,
};

/** A Mac: unified memory, no GPU figures. */
const MAC: MachineResources = { cpuPercent: 7.4, memory: { usedBytes: 16.6 * GIB, totalBytes: 24 * GIB }, gpuPercent: null, vram: null, sampledAt: 1 };

const shapeOf = (resources: MachineResources) => shapeAfter(null, resources);
const rows = (resources: MachineResources | null, shape: ResourcesShape = shapeOf(resources!)) => resourcesBlockFor(resources, shape)!.rows.map(stripAnsi);

// These cases are about the full block; the GPU column is off unless config turns it on.
beforeEach(() => setResourcesGpuEnabled(true));
afterEach(() => setResourcesGpuEnabled(null));

describe("resources block", () => {
  test("the GPU column is off by default and on with tui.resourcesGpu: true", () => {
    expect(resolveResourcesGpuSetting(() => ({}))).toBe(false);
    expect(resolveResourcesGpuSetting(() => ({ tui: { resourcesGpu: "yes" } }))).toBe(false);
    expect(resolveResourcesGpuSetting(() => ({ tui: { resourcesGpu: true } }))).toBe(true);
    expect(resolveResourcesGpuSetting(() => { throw new Error("no config"); })).toBe(false);
  });

  test("with the GPU column off, a machine that reports a GPU shows CPU and memory only", () => {
    expect(resourcesBlockFor(WHALE, shapeOf(WHALE), false)!.rows.map(stripAnsi)).toEqual([
      "  CPU: [██████░░░░] 64%     ",
      "  MEM: [███░░░░░░░] 10.8/31G",
    ]);
    expect(resourcesBlockFor(WHALE, shapeOf(WHALE), false)!.narrower).toBeUndefined();
    setResourcesGpuEnabled(false);
    const state = createInitialState();
    state.machineResources = WHALE;
    state.machineResourcesShape = shapeOf(WHALE);
    expect(resourcesBlock(state)!.rows.map(stripAnsi).join("\n")).not.toContain("GPU");
  });

  test("formats figures as the dwm blocks do", () => {
    expect(formatPercent(63.6)).toBe("64%");
    expect(formatPercent(100.4)).toBe("100%");
    expect(formatPercent(null)).toBe("—");
    expect(formatMemory({ usedBytes: 10.84 * GIB, totalBytes: 31.24 * GIB })).toBe("10.8/31G");
    expect(formatMemory({ usedBytes: 356016128, totalBytes: 8573157376 })).toBe("0.3/8G");
    expect(formatMemory(null)).toBe("—");
  });

  test("two aligned columns of 10-cell bars, as in the approved mock", () => {
    expect(rows(WHALE)).toEqual([
      "  CPU: [██████░░░░] 64%      GPU:  [░░░░░░░░░░] 0%    ",
      "  MEM: [███░░░░░░░] 10.8/31G VRAM: [░░░░░░░░░░] 0.3/8G",
    ]);
    const block = resourcesBlockFor(WHALE, shapeOf(WHALE))!;
    for (const row of block.rows) expect(stripAnsi(row).length).toBe(block.width);
    // Labels muted, figures accent, bars filled in accent over muted.
    expect(block.rows[0]).toContain(`${theme.muted}CPU: ${theme.text}[${theme.accent}██████${theme.muted}░░░░${theme.text}] ${theme.accent}64%`);
  });

  test("the width holds as figures change", () => {
    const busy = resourcesBlockFor({ ...WHALE, cpuPercent: 100, gpuPercent: 100, memory: { ...WHALE.memory!, usedBytes: WHALE.memory!.totalBytes } }, shapeOf(WHALE))!;
    expect(busy.width).toBe(resourcesBlockFor(WHALE, shapeOf(WHALE))!.width);
  });

  test("a machine without GPU figures shows CPU and memory only", () => {
    expect(rows(MAC)).toEqual([
      "  CPU: [█░░░░░░░░░] 7%      ",
      "  MEM: [███████░░░] 16.6/24G",
    ]);
  });

  test("a missing figure is a dash with an empty bar", () => {
    expect(rows({ ...WHALE, gpuPercent: null, cpuPercent: null }, shapeOf(WHALE))[0]).toBe("  CPU: [░░░░░░░░░░] —        GPU:  [░░░░░░░░░░] —     ");
  });

  test("before the first sample it is empty at its final width, and the sample fills it in place", () => {
    for (const machine of [WHALE, MAC]) {
      const placeholder = resourcesBlockFor(null, shapeOf(machine))!;
      const filled = resourcesBlockFor(machine, shapeOf(machine))!;
      expect(placeholder.width).toBe(filled.width);
      expect(placeholder.narrower?.[0]?.width).toBe(filled.narrower?.[0]?.width);
      for (const row of placeholder.rows) {
        expect(stripAnsi(row).length).toBe(placeholder.width);
        expect(stripAnsi(row)).not.toContain("█");
      }
    }
    expect(rows(null, shapeOf(WHALE))).toEqual([
      "  CPU: [░░░░░░░░░░] —        GPU:  [░░░░░░░░░░] —     ",
      "  MEM: [░░░░░░░░░░] —        VRAM: [░░░░░░░░░░] —     ",
    ]);
    // A route never seen: CPU and MEM, at the width of a "10.8/31G" machine.
    expect(resourcesBlockFor(null, DEFAULT_RESOURCES_SHAPE)!.width).toBe(resourcesBlockFor(MAC, shapeOf(MAC))!.width);
    // A daemon that sends none: no block.
    expect(resourcesBlockFor(null, null)).toBeNull();
  });

  test("a sample without the memory total (vm_stat not read yet) keeps the width", () => {
    const first = { ...MAC, cpuPercent: null, memory: null };
    expect(shapeAfter(shapeOf(MAC), first)).toEqual(shapeOf(MAC));
  });
});

function stateWith(resources: MachineResources | null) {
  const state = createInitialState();
  state.provider = "openai";
  state.authByProvider.openai = true;
  state.usageByProvider.openai = { fiveHour: { utilization: 25, resetsAt: null }, sevenDay: { utilization: 50, resetsAt: null } };
  state.machineResourcesShape = resources ? shapeOf(resources) : DEFAULT_RESOURCES_SHAPE;
  state.machineResources = resources;
  return state;
}

/** The bootstrap's tools_available, changing nothing else. */
function toolsAvailable(state: ReturnType<typeof stateWith>): Event {
  return { type: "tools_available", providers: state.providerRegistry ?? [], tools: [], authByProvider: { ...state.authByProvider }, authInfoByProvider: { ...state.authInfoByProvider } };
}

describe("in the status line", () => {
  test("sits right of Context and hides first, its GPU column before the rest", () => {
    const state = stateWith(WHALE);
    const usage = usageBlock(state)!.width;
    const context = contextBlock(state)!.width;
    const full = resourcesBlock(state)!;
    const machineOnly = full.narrower![0].width;
    const line = (cols: number) => stripAnsi(renderStatusLine(state, cols).lines.join("\n"));

    const wide = line(usage + context + full.width + 6);
    expect(wide.indexOf("Context")).toBeLessThan(wide.indexOf("CPU"));
    expect(wide).toContain("VRAM");

    const narrower = line(usage + context + full.width + 5);
    expect(narrower).toContain("CPU");
    expect(narrower).not.toContain("VRAM");
    expect(line(usage + context + machineOnly + 6)).toContain("MEM");

    const narrow = line(usage + context + machineOnly + 5);
    expect(narrow).toContain("Context");
    expect(narrow).toContain("Weekly");
    expect(narrow).not.toContain("CPU");
  });

  test("shows whichever daemon's machine sent the latest sample", () => {
    const state = stateWith(null);
    const shown = () => stripAnsi(renderStatusLine(state, 200).lines.join("\n"));
    expect(shown()).toContain("CPU: [░░░░░░░░░░] —");
    const placeholderWidth = resourcesBlock(state)!.width;

    // Local daemon on the Mac: filled in place.
    handleEvent({ type: "machine_resources", resources: MAC }, state, {} as DaemonActions);
    expect(shown()).toContain("16.6/24G");
    expect(shown()).not.toContain("GPU");
    expect(resourcesBlock(state)!.width).toBe(placeholderWidth);
    handleEvent(toolsAvailable(state), state, {} as DaemonActions);
    expect(shown()).toContain("16.6/24G");

    // /ssh whale: whale's shape at once, empty until whale's daemon sends its own.
    machineResourcesRouteSwitched(state, shapeOf(WHALE));
    expect(shown()).toContain("VRAM: [░░░░░░░░░░] —");
    const whaleWidth = resourcesBlock(state)!.width;
    handleEvent({ type: "machine_resources", resources: WHALE }, state, {} as DaemonActions);
    expect(shown()).toContain("10.8/31G");
    expect(shown()).toContain("0.3/8G");
    expect(shown()).not.toContain("16.6/24G");
    expect(resourcesBlock(state)!.width).toBe(whaleWidth);

    // The link drops: the block stays, empty.
    machineResourcesDisconnected(state);
    expect(resourcesBlock(state)!.width).toBe(whaleWidth);
    expect(shown()).not.toContain("10.8/31G");
  });

  test("a daemon that sends no sample before its bootstrap gets no block", () => {
    const state = stateWith(null);
    handleEvent(toolsAvailable(state), state, {} as DaemonActions);
    expect(resourcesBlock(state)).toBeNull();
    expect(stripAnsi(renderStatusLine(state, 200).lines.join("\n"))).not.toContain("CPU");
    // An upgraded daemon after a reconnect brings it back.
    machineResourcesDisconnected(state);
    handleEvent({ type: "machine_resources", resources: MAC }, state, {} as DaemonActions);
    expect(resourcesBlock(state)).not.toBeNull();
  });
});

describe("shape per route", () => {
  test("kept across TUI runs, written only on change", () => {
    const dir = mkdtempSync(join(tmpdir(), "exo-resources-shape-"));
    try {
      const path = join(dir, "tui-resources.json");
      const shapes = new ResourcesShapes(path);
      expect(shapes.forRoute("ssh:whale")).toEqual(DEFAULT_RESOURCES_SHAPE);
      shapes.remember("ssh:whale", shapeOf(WHALE));
      shapes.remember("local", null);
      const written = readFileSync(path, "utf8");
      shapes.remember("ssh:whale", shapeOf(WHALE));
      expect(readFileSync(path, "utf8")).toBe(written);

      const next = new ResourcesShapes(path);
      expect(next.forRoute("ssh:whale")).toEqual(shapeOf(WHALE));
      expect(next.forRoute("local")).toBeNull();
      expect(next.forRoute("ssh:other")).toEqual(DEFAULT_RESOURCES_SHAPE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
