#!/usr/bin/env bun
/**
 * Time a real TUI start against this worktree's running test daemon: the first
 * presented frame showing each part of the first screen (sidebar, the saved
 * conversation, tools, usage, accounts, Local/Remote update status) and every
 * protocol line the TUI wrote or read on the way.
 *
 *   bun scripts/dev/tui-startup-timeline.ts [--ssh] [--rtt-ms 100] [--handshake-rtts 6] [--focus CONV_ID] [--runs 3] [--entry src/main.ts] [--wire]
 *
 * --ssh starts the TUI as `--ssh fakehost` through scripts/dev/ssh-wan-sim.ts
 * (half the RTT each way, SSH -C compression, 20 Mbit/s); --handshake-rtts adds
 * OpenSSH's own handshake (about 6 round trips), which a real connection pays first. --focus is the
 * conversation the TUI reopens on every route (written to this worktree's tui-state.json).
 * Linux only (util-linux `script` provides the terminal). Refuses the primary
 * checkout: it rewrites tui-state.json and must never touch the real one.
 * Start the daemon first (scripts/dev/testd start <worktree>).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const ssh = args.includes("--ssh");
const rttMs = Number(option("--rtt-ms") ?? 100);
const runs = Number(option("--runs") ?? 3);
const focus = option("--focus") ?? null;
/** The TUI entry: src/launch.ts (bin/exocortex's), or src/main.ts for checkouts before it. */
const entry = option("--entry") ?? (existsSync(resolve(import.meta.dir, "../../tui/src/launch.ts")) ? "src/launch.ts" : "src/main.ts");
const repo = resolve(import.meta.dir, "../..");

if (!existsSync(join(repo, ".git")) || !readFileSync(join(repo, ".git"), "utf8").startsWith("gitdir:")) {
  console.error("Run this from a linked worktree (scripts/dev/create-worktree), never the primary checkout.");
  process.exit(2);
}

const work = join(tmpdir(), `tui-startup-timeline-${process.pid}`);
mkdirSync(join(work, "bin"), { recursive: true });
writeFileSync(join(work, "bin", "ssh"), `#!/bin/sh\nexec bun ${JSON.stringify(join(repo, "scripts/dev/ssh-wan-sim.ts"))} "$@"\n`);
chmodSync(join(work, "bin", "ssh"), 0o755);
mkdirSync(join(repo, "config", "storage"), { recursive: true });

try {
  for (let run = 1; run <= runs; run++) {
    writeFileSync(join(repo, "config", "storage", "tui-state.json"), JSON.stringify({
      version: 2,
      focusedConversationId: focus,
      sidebar: { open: true, currentFolderId: null, selectedItem: null, scrollOffset: 0 },
      conversationScrollPositions: {},
    }));
    const report = join(work, `run-${run}.json`);
    const tui = Bun.spawn(["script", "-q", "-E", "never", "-c", `stty cols 200 rows 50; bun run ${entry}${ssh ? " --ssh fakehost" : ""}`, "/dev/null"], {
      cwd: join(repo, "tui"),
      // Held open and never written: no keyboard input reaches the TUI.
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      env: {
        ...process.env,
        PATH: `${join(work, "bin")}:${process.env.PATH}`,
        WAN_ONE_WAY_MS: String(rttMs / 2),
        WAN_HANDSHAKE_RTTS: option("--handshake-rtts") ?? "0",
        EXOCORTEX_PROFILE_STARTUP: "1",
        EXOCORTEX_PROFILE_STARTUP_OUT: report,
      },
    });
    const deadline = setTimeout(() => tui.kill(), 30_000);
    await tui.exited;
    clearTimeout(deadline);
    if (!existsSync(report)) {
      console.error(`run ${run}: no report (is this worktree's daemon running?)`);
      continue;
    }
    const result = JSON.parse(readFileSync(report, "utf8"));
    const shown = Object.entries(result.firstFrameWith as Record<string, number>).sort((a, b) => a[1] - b[1]);
    console.log(`run ${run}: ${result.outcome} at ${result.readyMs} ms${result.missing.length ? `, missing ${result.missing.join(", ")}` : ""}`);
    console.log(`  first frame with: ${shown.map(([name, ms]) => `${name} ${ms}`).join(", ")}`);
    if (args.includes("--wire") && run === runs) {
      for (const entry of result.wire) {
        console.log(`  ${String(entry.t).padStart(8)} c${entry.client} ${entry.route.padEnd(14)} ${entry.dir.padEnd(4)} ${entry.type.padEnd(32)} ${String(entry.bytes).padStart(8)}`);
      }
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
