#!/usr/bin/env bun
/**
 * Run a real TUI against this worktree's test daemon (or a read-only tap of a
 * live one) and report every main-thread stall (EXOCORTEX_PROFILE_STALLS,
 * tui/src/stallprofile.ts): the longest blocking stretches, what they were made
 * of, the busiest labels and, with --marks, the frame timeline. docs/tui-stall-profiling.md.
 *
 *   bun scripts/dev/tui-stall-profile.ts --focus CONV_ID [--ssh] [--rtt-ms 100] [--seconds 8] [--runs 1] [--cols 200] [--rows 50] [--keys HEX@MS,...]
 *
 * --ssh goes through scripts/dev/ssh-wan-sim.ts like tui-startup-timeline.ts.
 * --real-ssh ALIAS uses the real ssh to ALIAS instead (e.g. on the Mac, to whale);
 * --remote-command CMD then replaces the remote `exocortexd proxy`, e.g. with
 * scripts/dev/readonly-daemon-tap.ts.
 * --keys writes terminal bytes (hex) at the given ms after start (clicks, wheel, keys).
 * --st answers like the owner's st: Kitty graphics, 20x10 px cells, smooth scroll
 * (DECRQM 2032) and image clip regions (2033), so image paths run as on the Mac;
 * --save-output FILE keeps what the TUI wrote to the terminal.
 * --scroll CONV=0.5,... saved reading positions; --focus the conversation it reopens.
 * --tui-prefix CMD wraps the TUI alone (e.g. `systemd-run --user --scope -q --unit=NAME`,
 * whose memory.high a test lowers to push the heap to swap).
 * --cpu-prof DIR / --heap-prof DIR write Bun's markdown CPU / heap profile of the TUI on exit.
 * --report FILE keeps the raw stall report; --timeline lists every span; --verbose.
 * Linux (util-linux `script`) and macOS (a python3 pty relay). Refuses the primary
 * checkout: it rewrites tui-state.json.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const ssh = args.includes("--ssh");
const rttMs = Number(option("--rtt-ms") ?? 100);
const seconds = Number(option("--seconds") ?? 8);
const runs = Number(option("--runs") ?? 1);
const cols = Number(option("--cols") ?? 200);
const rows = Number(option("--rows") ?? 50);
const focus = option("--focus") ?? null;
const cpuProf = option("--cpu-prof");
const keys = (option("--keys") ?? "").split(",").filter(Boolean).map(spec => {
  const [hex, at] = spec.split("@");
  return { bytes: Buffer.from(hex!, "hex"), at: Number(at) };
});
const st = args.includes("--st");
const realSsh = option("--real-ssh");
const remoteCommand = option("--remote-command");
const repo = resolve(import.meta.dir, "../..");

// A linked worktree has a .git file, a plain copy none; the primary checkout a directory.
if (existsSync(join(repo, ".git")) && !readFileSync(join(repo, ".git"), { encoding: "utf8", flag: "r" }).startsWith("gitdir:")) {
  console.error("Run this from a linked worktree (scripts/dev/create-worktree), never the primary checkout.");
  process.exit(2);
}

const work = join(tmpdir(), `tui-stall-profile-${process.pid}`);
mkdirSync(join(work, "bin"), { recursive: true });
if (realSsh) {
  const systemSsh = Bun.which("ssh");
  writeFileSync(join(work, "ssh-real.ts"), `const args = process.argv.slice(2);
const remote = ${JSON.stringify(remoteCommand ?? null)};
if (remote && args.at(-2) === "exocortexd" && args.at(-1) === "proxy") args.splice(-2, 2, remote);
const child = Bun.spawn([${JSON.stringify(systemSsh)}, ...args], { stdio: ["inherit", "inherit", "inherit"] });
process.exit(await child.exited);
`);
  writeFileSync(join(work, "bin", "ssh"), `#!/bin/sh\nexec bun ${JSON.stringify(join(work, "ssh-real.ts"))} "$@"\n`);
} else {
  writeFileSync(join(work, "bin", "ssh"), `#!/bin/sh\nexec bun ${JSON.stringify(join(repo, "scripts/dev/ssh-wan-sim.ts"))} "$@"\n`);
}
chmodSync(join(work, "bin", "ssh"), 0o755);
mkdirSync(join(repo, "config", "storage"), { recursive: true });
writeFileSync(join(work, "pty-relay.py"), `import os, pty, select, signal, sys
pid, fd = pty.fork()
if pid == 0:
    os.execvp("sh", ["sh", "-c", sys.argv[1]])
signal.signal(signal.SIGTERM, lambda *_: os.kill(pid, signal.SIGTERM))
inputs = [0, fd]
while True:
    try:
        ready, _, _ = select.select(inputs, [], [])
    except InterruptedError:
        continue
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        while data:
            data = data[os.write(1, data):]
    if 0 in ready:
        data = os.read(0, 65536)
        if data:
            while data:
                data = data[os.write(fd, data):]
        else:
            inputs.remove(0)
os.waitpid(pid, 0)
`);

interface Report { stalls: Array<{ at: number; ms: number; labels: string[] }>; spans: Array<{ at: number; ms: number; label: string; parent: string | null }>; marks: unknown[] }

try {
  for (let run = 1; run <= runs; run++) {
    writeFileSync(join(repo, "config", "storage", "tui-state.json"), JSON.stringify({
      version: 2,
      focusedConversationId: focus,
      sidebar: { open: true, currentFolderId: null, selectedItem: null, scrollOffset: 0 },
      // --scroll CONV=0.4,...: saved reading positions (fraction of the way down).
      conversationScrollPositions: Object.fromEntries((option("--scroll") ?? "").split(",").filter(Boolean)
        .map(pair => { const [id, at] = pair.split("="); return [id!, Number(at)]; })),
    }));
    const out = join(work, `run-${run}.json`);
    const heapProf = option("--heap-prof");
    const bunArgs = (cpuProf ? `--cpu-prof --cpu-prof-md --cpu-prof-dir=${JSON.stringify(resolve(cpuProf))} ` : "")
      + (heapProf ? `--heap-prof-md --heap-prof-dir=${JSON.stringify(resolve(heapProf))} ` : "");
    const route = realSsh ? ` --ssh ${realSsh}` : ssh ? " --ssh fakehost" : "";
    // --tui-prefix wraps the TUI alone, e.g. in a systemd scope whose memory a test squeezes.
    const prefix = option("--tui-prefix") ? `${option("--tui-prefix")} ` : "";
    const shell = `stty cols ${cols} rows ${rows}; exec ${prefix}bun ${bunArgs}run src/launch.ts${route}`;
    const tui = Bun.spawn(process.platform === "darwin" || process.env.TUI_STALL_PTY_RELAY === "1"
      // BSD script needs a terminal on its own stdin; a small pty relay instead.
      ? ["python3", "-I", join(work, "pty-relay.py"), shell]
      : ["script", "-q", "-E", "never", "-c", shell, "/dev/null"], {
      cwd: join(repo, "tui"),
      stdin: "pipe",
      stdout: st ? "pipe" : "ignore",
      stderr: Bun.file(join(work, `stderr-${run}.txt`)),
      env: {
        ...process.env,
        PATH: `${join(work, "bin")}:${process.env.PATH}`,
        WAN_ONE_WAY_MS: String(rttMs / 2),
        EXOCORTEX_PROFILE_STALLS: out,
      },
    });
    let stdoutBytes = 0;
    if (st) void (async () => {
      const reply = (bytes: string) => { tui.stdin.write(bytes); tui.stdin.flush(); };
      let tail = "";
      for await (const chunk of tui.stdout as ReadableStream<Uint8Array>) {
        stdoutBytes += chunk.length;
        if (option("--save-output")) appendFileSync(option("--save-output")!, chunk);
        const text = tail + Buffer.from(chunk).toString("latin1");
        const seen = tail.length;
        tail = text.slice(-64);
        // Answer each query once: skip matches that lie wholly in the carried-over tail.
        const asked = (query: string) => {
          for (let at = text.indexOf(query); at >= 0; at = text.indexOf(query, at + 1)) {
            if (at + query.length > seen) return true;
          }
          return false;
        };
        if (asked("\x1b_Ga=q")) reply(`\x1b_Gi=${0x7ffffff0};OK\x1b\\`);
        if (asked("\x1b[16t")) reply("\x1b[6;20;10t");
        if (asked("\x1b[?2032$p")) reply("\x1b[?2032;1$y");
        if (asked("\x1b[?2033$p")) reply("\x1b[?2033;1$y");
        if (asked("\x1b[c")) reply("\x1b[?62;22c");
      }
    })();
    const started = performance.now();
    for (const key of keys) {
      setTimeout(() => { tui.stdin.write(key.bytes); tui.stdin.flush(); }, key.at);
    }
    await Bun.sleep(seconds * 1000);
    // ctrl+c twice would prompt; SIGTERM runs the TUI's cleanup and exits.
    const pids = Bun.spawnSync(["pgrep", "-P", String(tui.pid)]).stdout.toString().trim().split("\n").filter(Boolean);
    if (args.includes("--verbose")) console.error(`run ${run}: stopping ${pids.join(" ") || "(no children)"} of ${tui.pid}, exited=${tui.exitCode}`);
    for (const pid of pids) try { process.kill(Number(pid), "SIGTERM"); } catch { /* gone */ }
    const deadline = setTimeout(() => tui.kill("SIGKILL"), 5_000);
    await tui.exited;
    clearTimeout(deadline);
    if (!existsSync(out)) {
      const stderr = existsSync(join(work, `stderr-${run}.txt`)) ? readFileSync(join(work, `stderr-${run}.txt`), "utf8").slice(-2000) : "";
      console.error(`run ${run}: no report (exit ${tui.exitCode}, ${stdoutBytes} bytes to the terminal)${stderr ? `\n${stderr}` : ""}`);
      continue;
    }
    const report = JSON.parse(readFileSync(out, "utf8")) as Report;
    if (option("--report")) writeFileSync(runs > 1 ? `${option("--report")}.${run}` : option("--report")!, JSON.stringify(report));
    const stalls = report.stalls.filter(s => s.at > 0);
    const total = stalls.reduce((sum, s) => sum + s.ms, 0);
    console.log(`run ${run}: ${stalls.length} stalls >=16 ms, ${Math.round(total)} ms blocked in ${seconds} s${st ? `, ${Math.round(stdoutBytes / 1024)} KiB to the terminal` : ""}; max ${Math.max(0, ...stalls.map(s => s.ms))} ms`);
    for (const stall of [...stalls].sort((a, b) => b.ms - a.ms).slice(0, 12)) {
      console.log(`  ${String(stall.at).padStart(8)} ms  ${String(stall.ms).padStart(7)} ms  ${stall.labels.join(" ") || "(unlabelled)"}`);
    }
    const byLabel = new Map<string, { n: number; ms: number; max: number }>();
    for (const span of report.spans) {
      const key = span.parent ? `${span.parent} > ${span.label}` : span.label;
      const entry = byLabel.get(key) ?? { n: 0, ms: 0, max: 0 };
      entry.n++; entry.ms += span.ms; entry.max = Math.max(entry.max, span.ms);
      byLabel.set(key, entry);
    }
    console.log("  spans >=8 ms by label:");
    for (const [label, e] of [...byLabel].sort((a, b) => b[1].ms - a[1].ms).slice(0, 15)) {
      console.log(`    ${label.padEnd(44)} n=${String(e.n).padStart(4)}  total ${String(Math.round(e.ms)).padStart(6)} ms  max ${e.max} ms`);
    }
    if (args.includes("--marks")) for (const mark of report.marks as Array<{ at: number; mark: string }>) console.log(`    ${String(mark.at).padStart(8)} ${mark.mark}`);
    if (args.includes("--timeline")) for (const span of report.spans) console.log(`    ${String(span.at).padStart(8)} ${String(span.ms).padStart(7)} ${span.parent ? `${span.parent} > ` : ""}${span.label}`);
    void started;
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
