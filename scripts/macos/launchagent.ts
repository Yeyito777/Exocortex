/**
 * Generate or rewrite the com.exocortex.daemon LaunchAgent so it runs the
 * signed launcher (macos/launcher) instead of bin/exocortexd.
 *
 * An existing plist is edited in place: only the top-level ProgramArguments,
 * Program and AssociatedBundleIdentifiers keys change, so logs, environment,
 * KeepAlive and anything else hand-tuned are preserved. Without one, a fresh
 * plist mirroring the Linux systemd unit is written.
 *
 * `--mode plain` is the installer's fallback without Xcode's command-line
 * tools (no clang to build the launcher): /bin/bash runs run-daemon.sh, as
 * the launcher would. It only creates a missing plist, never rewrites one.
 *
 * Usage (bun, from build-launcher.sh and install.sh):
 *   bun scripts/macos/launchagent.ts --plist PATH --executable EXE --repo DIR [--bun-dir DIR] [--backup-dir DIR]
 *   bun scripts/macos/launchagent.ts --mode plain --plist PATH --repo DIR [--bun-dir DIR]
 * Prints "created", "updated" or "unchanged".
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";

export const DAEMON_LABEL = "com.exocortex.daemon";
export const LAUNCHER_BUNDLE_ID = "dev.yeyito.exocortex.daemon";

export interface LauncherTarget {
  /** Absolute path of the launcher executable inside the .app bundle. */
  executable: string;
  /** Exocortex checkout the launcher runs. */
  repoDir: string;
}

interface AgentEnvironment {
  /** Exocortex checkout the daemon runs from. */
  repoDir: string;
  label?: string;
  home: string;
  /** Directory of the bun found at install time; PATH fallback only. */
  bunDir?: string;
}

export interface FreshPlistOptions extends LauncherTarget, AgentEnvironment {}

export function launcherProgramArguments({ executable, repoDir }: LauncherTarget): string[] {
  return [executable, "--repo", repoDir];
}

/** Without the launcher: Apple's /bin/bash runs the same script the launcher runs. */
export function plainProgramArguments(repoDir: string): string[] {
  return ["/bin/bash", join(repoDir, "scripts", "setup", "run-daemon.sh")];
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function stringArray(values: string[], indent: string, step: string): string {
  return [`<array>`, ...values.map(value => `${indent}${step}<string>${escapeXml(value)}</string>`), `${indent}</array>`].join("\n");
}

export function renderDaemonLaunchAgent(options: FreshPlistOptions): string {
  return renderAgent(options, launcherProgramArguments(options), LAUNCHER_BUNDLE_ID);
}

export function renderPlainDaemonLaunchAgent(options: AgentEnvironment): string {
  return renderAgent(options, plainProgramArguments(options.repoDir), null);
}

function renderAgent(options: AgentEnvironment, programArguments: string[], bundleId: string | null): string {
  const label = options.label ?? DAEMON_LABEL;
  const runtime = join(options.repoDir, "config", "runtime");
  const pathDirs = [
    join(options.home, ".local", "bin"),
    ...(options.bunDir ? [options.bunDir] : []),
    join(options.home, ".bun", "bin"),
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin",
  ];
  const path = [...new Set(pathDirs)].join(":");
  const s = (value: string) => `<string>${escapeXml(value)}</string>`;
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `\t<key>Label</key>`,
    `\t${s(label)}`,
    `\t<key>ProgramArguments</key>`,
    `\t${stringArray(programArguments, "\t", "\t")}`,
    ...(bundleId ? [`\t<key>AssociatedBundleIdentifiers</key>`, `\t${s(bundleId)}`] : []),
    `\t<key>WorkingDirectory</key>`,
    `\t${s(join(options.repoDir, "daemon"))}`,
    `\t<key>EnvironmentVariables</key>`,
    `\t<dict>`,
    `\t\t<key>PATH</key>`,
    `\t\t${s(path)}`,
    `\t</dict>`,
    `\t<key>RunAtLoad</key>`,
    `\t<true/>`,
    // Exit 0 (`exocortexd stop`) stays down; 75 relaunches: a restart request, and any
    // other signal (a stray kill), which the daemon answers with 75 on macOS.
    `\t<key>KeepAlive</key>`,
    `\t<dict>`,
    `\t\t<key>SuccessfulExit</key>`,
    `\t\t<false/>`,
    `\t</dict>`,
    `\t<key>StandardOutPath</key>`,
    `\t${s(join(runtime, "launchd.out.log"))}`,
    `\t<key>StandardErrorPath</key>`,
    `\t${s(join(runtime, "launchd.err.log"))}`,
    `</dict>`,
    `</plist>`,
    "",
  ].join("\n");
}

// ── In-place rewrite ─────────────────────────────────────────────────

interface Span { start: number; end: number }

/** Index of the next element tag at or after `pos` (before `limit`), skipping comments. */
function nextTag(xml: string, pos: number, limit = xml.length): number {
  for (;;) {
    const index = xml.indexOf("<", pos);
    if (index < 0 || index >= limit) return -1;
    if (!xml.startsWith("<!--", index)) return index;
    const close = xml.indexOf("-->", index + 4);
    if (close < 0) throw new Error(`unterminated comment at offset ${index}`);
    pos = close + 3;
  }
}

/** End index of the element starting at `start` (handles nesting, `<tag/>` and comments). */
function elementEnd(xml: string, start: number): number {
  const open = /^<([A-Za-z]+)\b[^>]*?(\/?)>/.exec(xml.slice(start));
  if (!open) throw new Error(`expected a plist value at offset ${start}`);
  if (open[2] === "/") return start + open[0].length;
  const name = open[1];
  const tag = new RegExp(`^<(/?)${name}\\b[^>]*?(/?)>`);
  let depth = 1;
  for (let pos = nextTag(xml, start + open[0].length); pos >= 0; pos = nextTag(xml, pos + 1)) {
    const match = tag.exec(xml.slice(pos, pos + 256));
    if (!match || match[2] === "/") continue;
    depth += match[1] === "/" ? -1 : 1;
    if (depth === 0) return pos + match[0].length;
  }
  throw new Error(`unterminated <${name}> at offset ${start}`);
}

/** Offsets of the root dict's contents, plus every top-level key. */
function topLevel(xml: string): { rootOpen: Span; rootClose: Span; keys: Map<string, { key: Span; value: Span }> } {
  if (xml.startsWith("bplist")) throw new Error("binary plist; convert it with `plutil -convert xml1` first");
  const rootStart = xml.search(/<dict\s*>/);
  if (rootStart < 0 || !/<plist\b/.test(xml.slice(0, rootStart))) throw new Error("not an XML property list with a root <dict>");
  const rootOpenEnd = xml.indexOf(">", rootStart) + 1;
  const rootEnd = elementEnd(xml, rootStart);
  const rootCloseStart = xml.lastIndexOf("</dict", rootEnd);
  const keys = new Map<string, { key: Span; value: Span }>();

  let pos = rootOpenEnd;
  for (;;) {
    const keyStart = nextTag(xml, pos, rootCloseStart);
    if (keyStart < 0) break;
    const keyMatch = /^<key>([^<]*)<\/key>/.exec(xml.slice(keyStart));
    if (!keyMatch) throw new Error(`expected <key> at offset ${keyStart}`);
    const keyEnd = keyStart + keyMatch[0].length;
    const valueStart = nextTag(xml, keyEnd, rootCloseStart);
    if (valueStart < 0) throw new Error(`key ${keyMatch[1]} has no value`);
    const valueEnd = elementEnd(xml, valueStart);
    keys.set(keyMatch[1], { key: { start: keyStart, end: keyEnd }, value: { start: valueStart, end: valueEnd } });
    pos = valueEnd;
  }
  return {
    rootOpen: { start: rootStart, end: rootOpenEnd },
    rootClose: { start: rootCloseStart, end: rootEnd },
    keys,
  };
}

function lineIndent(xml: string, index: number): string {
  const lineStart = xml.lastIndexOf("\n", index - 1) + 1;
  return /^[ \t]*/.exec(xml.slice(lineStart, index))![0];
}

/** Remove a span together with the whitespace before it on its line(s). */
function removeWithLeadingSpace(xml: string, start: number, end: number): string {
  let from = start;
  while (from > 0 && /[ \t]/.test(xml[from - 1])) from--;
  if (from > 0 && xml[from - 1] === "\n") from--;
  return xml.slice(0, from) + xml.slice(end);
}

/**
 * Point an existing LaunchAgent at the launcher. Edits only top-level
 * ProgramArguments, Program and AssociatedBundleIdentifiers.
 */
export function rewriteDaemonLaunchAgent(xml: string, target: LauncherTarget): string {
  const initial = topLevel(xml);
  const firstKey = [...initial.keys.values()][0];
  const indent = firstKey ? lineIndent(xml, firstKey.key.start) : "\t";
  const step = indent || "\t";
  const values: Record<string, string> = {
    ProgramArguments: stringArray(launcherProgramArguments(target), indent, step),
    AssociatedBundleIdentifiers: `<string>${escapeXml(LAUNCHER_BUNDLE_ID)}</string>`,
  };

  // Program would override ProgramArguments[0] as the executable.
  const program = initial.keys.get("Program");
  if (program) xml = removeWithLeadingSpace(xml, program.key.start, program.value.end);

  for (const [name, value] of Object.entries(values)) {
    const { rootClose, keys } = topLevel(xml);
    const existing = keys.get(name);
    if (existing) {
      xml = xml.slice(0, existing.value.start) + value + xml.slice(existing.value.end);
    } else {
      // Insert before the root </dict>, after the last top-level entry.
      const before = xml.slice(0, rootClose.start).replace(/\s*$/, "");
      xml = `${before}\n${indent}<key>${name}</key>\n${indent}${value}\n${xml.slice(rootClose.start)}`;
    }
  }
  return xml;
}

export type InstallResult = "created" | "updated" | "unchanged";

export type InstallOptions = (
  | ({ mode?: "launcher" } & FreshPlistOptions)
  | ({ mode: "plain" } & AgentEnvironment)
) & {
  plistPath: string;
  /** Where the previous plist is copied before an update. */
  backupDir?: string;
  now?: Date;
};

export function installDaemonLaunchAgent(options: InstallOptions): InstallResult {
  const { plistPath } = options;
  const exists = existsSync(plistPath);
  const current = exists ? readFileSync(plistPath, "utf-8") : null;
  if (options.mode === "plain") {
    // Never downgrade an agent that already runs (likely the launcher).
    if (current !== null) return "unchanged";
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, renderPlainDaemonLaunchAgent(options));
    return "created";
  }
  const next = current === null ? renderDaemonLaunchAgent(options) : rewriteDaemonLaunchAgent(current, options);
  if (next === current) return "unchanged";

  mkdirSync(dirname(plistPath), { recursive: true });
  if (current !== null) {
    const backupDir = options.backupDir ?? dirname(plistPath);
    const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, `${basename(plistPath)}.${stamp}.bak`), current);
  }
  const tmp = `${plistPath}.${process.pid}.tmp`;
  writeFileSync(tmp, next);
  renameSync(tmp, plistPath);
  return current === null ? "created" : "updated";
}

// ── CLI ──────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag.startsWith("--") || value === undefined) throw new Error(`bad argument: ${flag}`);
    args[flag.slice(2)] = value;
  }
  return args;
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const mode = args.mode ?? "launcher";
    if (mode !== "launcher" && mode !== "plain") throw new Error(`unknown --mode ${mode}`);
    for (const required of mode === "plain" ? ["plist", "repo"] : ["plist", "executable", "repo"]) {
      if (!args[required]) throw new Error(`missing --${required}`);
    }
    const common = {
      plistPath: args.plist,
      repoDir: args.repo,
      home: args.home ?? process.env.HOME ?? "",
      bunDir: args["bun-dir"],
      label: args.label,
      backupDir: args["backup-dir"],
    };
    const result = installDaemonLaunchAgent(mode === "plain"
      ? { mode: "plain", ...common }
      : { ...common, executable: args.executable });
    console.log(result);
  } catch (err) {
    console.error(`launchagent: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
