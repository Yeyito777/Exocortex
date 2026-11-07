import { describe, expect, test } from "bun:test";
import { handleEvent, type DaemonActions } from "../events";
import { stripAnsi } from "../historycursor";
import type { MachineResources } from "../protocol";
import { createInitialState } from "../state";
import { renderStatusLine } from "../statusline";
import { theme } from "../theme";
import { contextBlock } from "./context";
import { formatMemory, formatPercent, resourcesBlock, resourcesBlockFor } from "./resources";
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

const rows = (resources: MachineResources) => resourcesBlockFor(resources)!.rows.map(stripAnsi);

describe("resources block", () => {
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
    const block = resourcesBlockFor(WHALE)!;
    for (const row of block.rows) expect(stripAnsi(row).length).toBe(block.width);
    // Labels muted, figures accent, bars filled in accent over muted.
    expect(block.rows[0]).toContain(`${theme.muted}CPU: ${theme.text}[${theme.accent}██████${theme.muted}░░░░${theme.text}] ${theme.accent}64%`);
  });

  test("the width holds as figures change", () => {
    const busy = resourcesBlockFor({ ...WHALE, cpuPercent: 100, gpuPercent: 100, memory: { ...WHALE.memory!, usedBytes: WHALE.memory!.totalBytes } })!;
    expect(busy.width).toBe(resourcesBlockFor(WHALE)!.width);
  });

  test("a machine without GPU figures shows CPU and memory only", () => {
    expect(rows(MAC)).toEqual([
      "  CPU: [█░░░░░░░░░] 7%      ",
      "  MEM: [███████░░░] 16.6/24G",
    ]);
  });

  test("a missing figure is a dash with an empty bar; nothing known hides the block", () => {
    expect(rows({ ...WHALE, gpuPercent: null, cpuPercent: null })[0]).toBe("  CPU: [░░░░░░░░░░] —        GPU:  [░░░░░░░░░░] —     ");
    expect(resourcesBlockFor({ cpuPercent: null, memory: null, gpuPercent: null, vram: null, sampledAt: 1 })).toBeNull();
    expect(resourcesBlockFor(null)).toBeNull();
  });
});

function stateWith(resources: MachineResources | null) {
  const state = createInitialState();
  state.provider = "openai";
  state.authByProvider.openai = true;
  state.usageByProvider.openai = { fiveHour: { utilization: 25, resetsAt: null }, sevenDay: { utilization: 50, resetsAt: null } };
  state.machineResources = resources;
  return state;
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
    expect(stripAnsi(renderStatusLine(state, 200).lines.join("\n"))).not.toContain("CPU");

    // Local daemon on the Mac.
    handleEvent({ type: "machine_resources", resources: MAC }, state, {} as DaemonActions);
    let shown = stripAnsi(renderStatusLine(state, 200).lines.join("\n"));
    expect(shown).toContain("16.6/24G");
    expect(shown).not.toContain("GPU");

    // After /ssh whale, whale's daemon sends its own.
    handleEvent({ type: "machine_resources", resources: WHALE }, state, {} as DaemonActions);
    shown = stripAnsi(renderStatusLine(state, 200).lines.join("\n"));
    expect(shown).toContain("10.8/31G");
    expect(shown).toContain("0.3/8G");
    expect(shown).not.toContain("16.6/24G");
  });
});
