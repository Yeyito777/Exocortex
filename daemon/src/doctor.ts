/**
 * `exocortexd doctor [--json]`: what an Exocortex install has and lacks.
 *
 * Apps run `exocortexd doctor --json` to decide whether to tell the user to
 * install or sign in (README › Use Exocortex from your own program). It only
 * reads files and asks the daemon for a `pong`; it never starts a login, and
 * it does not run `claude auth status`, which can lose a refreshed Claude
 * login (providers/anthropic/auth-cache.ts). Claude Code's sign-in is read
 * from its own config file instead.
 *
 * The static imports are relative and dependency-free so the report still
 * works before `bun install`; provider logins are loaded lazily.
 */

import { existsSync, lstatSync, readFileSync, realpathSync } from "fs";
import { connect } from "net";
import { homedir } from "os";
import { join } from "path";
import { pidPath, repoRoot, socketPath } from "../../shared/src/paths";

export const SYSTEMD_UNIT = "exocortex-daemon.service";
export const DEFAULT_LAUNCHD_LABEL = "com.exocortex.daemon";
/** The launcher app's executable, relative to the .app (macos/launcher, scripts/macos/build-launcher.sh). */
export const LAUNCHER_EXECUTABLE = "Contents/MacOS/exocortex-daemon";

export interface DoctorProblem {
  id: string;
  severity: "error" | "warning";
  message: string;
  fix: string;
}

export interface DoctorProvider {
  authenticated: boolean;
  status: string;
  email: string | null;
  source: string | null;
}

export interface DoctorReport {
  /** Bumped only on incompatible changes to this shape. */
  schema: 1;
  /** No error-severity problem: the daemon is up and some provider is signed in. */
  ok: boolean;
  platform: NodeJS.Platform;
  exocortex: { repoDir: string; version: string | null; commit: string | null; branch: string | null; dependencies: boolean };
  bun: { path: string; version: string };
  claudeCode: { found: boolean; path: string | null; version: string | null; loggedIn: boolean | null; email: string | null };
  daemon: {
    socket: string;
    running: boolean;
    responsive: boolean;
    pid: number | null;
    service: { manager: "systemd" | "launchd" | "none"; name: string | null; installed: boolean; active: boolean | null };
  };
  /** Per provider id; null when the daemon's dependencies are not installed. */
  providers: Record<string, DoctorProvider> | null;
  commands: { exocortexd: string | null; tui: string | null };
  /** macOS only (else null): the signed launcher app privacy grants belong to. */
  macos: DoctorMacos | null;
  problems: DoctorProblem[];
}

export interface DoctorMacos {
  /** The "Exocortex Daemon.app" the LaunchAgent runs, or the default install path. */
  launcherApp: string;
  launcherInstalled: boolean;
  /** "identity": a certificate, so grants survive rebuilds; "adhoc": they do not. */
  launcherSigning: "identity" | "adhoc" | "unsigned" | null;
  /** Whether the LaunchAgent's program is the launcher; null without a LaunchAgent. */
  agentUsesLauncher: boolean | null;
  /** The launcher app's Full Disk Access, checked without prompting; null when not checked. */
  fullDiskAccess: "granted" | "missing" | "unknown" | null;
}

// ── Probes ───────────────────────────────────────────────────────────

/** The socket a client should use: EXOCORTEX_SOCKET first, else this checkout's instance. */
export function clientSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.EXOCORTEX_SOCKET?.trim() || socketPath();
}

function run(argv: string[], timeoutMs = 5000): { ok: boolean; stdout: string; stderr: string } {
  try {
    const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: timeoutMs });
    return { ok: result.exitCode === 0, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString().trim() };
  } catch {
    return { ok: false, stdout: "", stderr: "" };
  }
}

/** Connect and ask for a light `pong` (no conversation bootstrap). */
export function probeDaemon(socket: string, timeoutMs = 3000): Promise<{ running: boolean; responsive: boolean }> {
  if (process.platform !== "win32" && !existsSync(socket)) return Promise.resolve({ running: false, responsive: false });
  return new Promise((done) => {
    let connected = false;
    let buffer = "";
    const client = connect(socket);
    const finish = (responsive: boolean) => {
      clearTimeout(timer);
      client.destroy();
      done({ running: connected, responsive });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    client.on("connect", () => {
      connected = true;
      client.write(`${JSON.stringify({ type: "ping", reqId: "doctor", updateStatusOnly: true })}\n`);
    });
    client.on("data", (chunk) => {
      buffer += chunk.toString();
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        try {
          const event = JSON.parse(line) as { type?: string; reqId?: string };
          if (event.type === "pong" && event.reqId === "doctor") return finish(true);
        } catch { /* not ours */ }
      }
    });
    client.on("error", () => finish(false));
  });
}

function readPid(): number | null {
  try {
    const pid = parseInt(readFileSync(pidPath(), "utf-8").trim(), 10);
    if (isNaN(pid)) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** Same lookup as providers/anthropic/cli.ts, which the daemon uses. */
export function findClaudeBinary(env: NodeJS.ProcessEnv = process.env, home = homedir()): string | null {
  if (env.CLAUDE_CODE_BIN) return existsSync(env.CLAUDE_CODE_BIN) ? env.CLAUDE_CODE_BIN : null;
  const onPath = Bun.which("claude", { PATH: env.PATH ?? "" });
  if (onPath) return onPath;
  for (const candidate of [join(home, ".local", "bin", "claude"), join(home, ".claude", "local", "claude")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Claude Code's sign-in from its config: `oauthAccount` in .claude.json, plus
 * the credentials file on Linux (macOS keeps them in the Keychain).
 */
export function readClaudeLogin(env: NodeJS.ProcessEnv = process.env, home = homedir(), platform = process.platform): { loggedIn: boolean; email: string | null } {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  const configFile = configDir ? join(configDir, ".claude.json") : join(home, ".claude.json");
  let email: string | null = null;
  let hasAccount = false;
  try {
    const config = JSON.parse(readFileSync(configFile, "utf-8")) as { oauthAccount?: { emailAddress?: unknown } };
    hasAccount = !!config.oauthAccount;
    email = typeof config.oauthAccount?.emailAddress === "string" ? config.oauthAccount.emailAddress : null;
  } catch { /* not signed in, or never run */ }
  const hasCredentials = platform === "darwin" || existsSync(join(configDir || join(home, ".claude"), ".credentials.json"));
  const loggedIn = hasAccount && hasCredentials;
  return { loggedIn, email: loggedIn ? email : null };
}

function serviceState(home = homedir()): DoctorReport["daemon"]["service"] {
  if (process.platform === "linux") {
    // No user manager (containers, some WSL setups): there is no service to suggest.
    if (!run(["systemctl", "--user", "show-environment"]).ok) return { manager: "none", name: null, installed: false, active: null };
    const installed = existsSync(join(home, ".config", "systemd", "user", SYSTEMD_UNIT));
    const active = installed ? run(["systemctl", "--user", "is-active", "--quiet", SYSTEMD_UNIT]).ok : null;
    return { manager: "systemd", name: SYSTEMD_UNIT, installed, active };
  }
  if (process.platform === "darwin") {
    const label = process.env.EXOCORTEX_LAUNCHD_LABEL || DEFAULT_LAUNCHD_LABEL;
    const installed = existsSync(join(home, "Library", "LaunchAgents", `${label}.plist`));
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const active = installed ? /state = running/.test(run(["launchctl", "print", `gui/${uid}/${label}`]).stdout) : null;
    return { manager: "launchd", name: label, installed, active };
  }
  return { manager: "none", name: null, installed: false, active: null };
}

/** The first ProgramArguments string of a LaunchAgent plist (XML), or null. */
export function launchAgentProgram(plistXml: string): string | null {
  const match = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(plistXml);
  if (!match) return null;
  return match[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** The .app a launcher executable path belongs to, or null if it is not one. */
export function launcherAppOf(program: string | null): string | null {
  const suffix = `.app/${LAUNCHER_EXECUTABLE}`;
  return program?.endsWith(suffix) ? program.slice(0, -LAUNCHER_EXECUTABLE.length - 1) : null;
}

function macosState(home = homedir()): DoctorMacos {
  const label = process.env.EXOCORTEX_LAUNCHD_LABEL || DEFAULT_LAUNCHD_LABEL;
  let program: string | null = null;
  let hasAgent = false;
  try {
    program = launchAgentProgram(readFileSync(join(home, "Library", "LaunchAgents", `${label}.plist`), "utf-8"));
    hasAgent = true;
  } catch { /* no LaunchAgent, or a binary plist */ }
  const fromAgent = launcherAppOf(program);
  const launcherApp = fromAgent ?? join(home, "Applications", "Exocortex Daemon.app");
  const executable = join(launcherApp, LAUNCHER_EXECUTABLE);
  const launcherInstalled = existsSync(executable);

  let launcherSigning: DoctorMacos["launcherSigning"] = null;
  let fullDiskAccess: DoctorMacos["fullDiskAccess"] = null;
  if (launcherInstalled) {
    // codesign -dv prints to stderr; an unsigned bundle fails.
    const sign = run(["codesign", "-dv", launcherApp]);
    launcherSigning = !sign.ok ? "unsigned" : /Signature=adhoc/.test(sign.stderr) ? "adhoc" : "identity";
    // Runs as the app itself and never prompts (macos/launcher/launcher.c).
    const word = run([executable, "--check-full-disk-access"]).stdout;
    fullDiskAccess = word === "granted" || word === "missing" ? word : "unknown";
  }
  return { launcherApp, launcherInstalled, launcherSigning, agentUsesLauncher: hasAgent ? fromAgent !== null : null, fullDiskAccess };
}

/** A command on PATH or in ~/.local/bin (where the installer links it). */
function findCommand(name: string, home = homedir()): string | null {
  const onPath = Bun.which(name);
  if (onPath) return onPath;
  const local = join(home, ".local", "bin", name);
  try {
    lstatSync(local);
    return local;
  } catch {
    return null;
  }
}

/** Whether a linked command resolves into this checkout (a stale link to another clone does not count). */
export function linksInto(command: string, repoDir: string): boolean {
  try {
    // Real paths on both sides: macOS's /tmp is /private/tmp, for one.
    return realpathSync(command).startsWith(realpathSync(repoDir) + "/");
  } catch {
    return false;
  }
}

async function providerLogins(): Promise<Record<string, DoctorProvider> | null> {
  try {
    const { getAuthInfoByProvider } = await import("./auth");
    const out: Record<string, DoctorProvider> = {};
    for (const [id, info] of Object.entries(getAuthInfoByProvider())) {
      out[id] = { authenticated: info.authenticated, status: info.status, email: info.email, source: info.source };
    }
    return out;
  } catch {
    return null;
  }
}

function packageVersion(repoDir: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(repoDir, "daemon", "package.json"), "utf-8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

// ── Report ───────────────────────────────────────────────────────────

export async function collectDoctorReport(): Promise<DoctorReport> {
  const repoDir = repoRoot();
  const commit = run(["git", "-C", repoDir, "rev-parse", "--short", "HEAD"]);
  const branch = run(["git", "-C", repoDir, "symbolic-ref", "--short", "-q", "HEAD"]);
  // Bun's isolated installs keep it under daemon/; hoisted ones at the root.
  const dependencies = ["daemon", "."].some(dir => existsSync(join(repoDir, dir, "node_modules", "@anthropic-ai", "claude-agent-sdk")));

  const claudePath = findClaudeBinary();
  const claudeVersion = claudePath ? run([claudePath, "--version"]).stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null : null;
  const claudeLogin = claudePath ? readClaudeLogin() : { loggedIn: null, email: null };

  const socket = clientSocketPath();
  const [probe, providers] = await Promise.all([probeDaemon(socket), dependencies ? providerLogins() : Promise.resolve(null)]);
  const service = serviceState();

  const exocortexd = findCommand("exocortexd");
  const tuiCommand = findCommand("exocortex");
  const tui = tuiCommand && linksInto(tuiCommand, repoDir) ? tuiCommand : null;

  const report: DoctorReport = {
    schema: 1,
    ok: false,
    platform: process.platform,
    exocortex: { repoDir, version: packageVersion(repoDir), commit: commit.ok ? commit.stdout : null, branch: branch.ok ? branch.stdout : null, dependencies },
    bun: { path: process.execPath, version: Bun.version },
    claudeCode: { found: !!claudePath, path: claudePath, version: claudeVersion, loggedIn: claudeLogin.loggedIn, email: claudeLogin.email },
    // The PID file is this checkout's; it says nothing about an EXOCORTEX_SOCKET elsewhere.
    daemon: { socket, running: probe.running, responsive: probe.responsive, pid: socket === socketPath() ? readPid() : null, service },
    providers,
    commands: { exocortexd, tui },
    macos: process.platform === "darwin" ? macosState() : null,
    problems: [],
  };
  report.problems = diagnose(report);
  report.ok = !report.problems.some(problem => problem.severity === "error");
  return report;
}

/** Problems with the fix to tell the user, most fundamental first. */
export function diagnose(report: DoctorReport): DoctorProblem[] {
  const problems: DoctorProblem[] = [];
  const add = (id: string, severity: DoctorProblem["severity"], message: string, fix: string) => problems.push({ id, severity, message, fix });
  const repo = report.exocortex.repoDir;

  if (!report.exocortex.dependencies) {
    add("dependencies-missing", "error", "Dependencies are not installed.", `cd ${repo} && bun install --frozen-lockfile`);
  }
  if (!report.daemon.running) {
    const start = report.daemon.service.installed ? "exocortexd start"
      : report.daemon.service.manager === "none" ? "Run `exocortexd` (it stays in the foreground)"
        : "Run `exocortexd` in a terminal, or rerun the installer to add the service";
    add("daemon-not-running", "error", "The daemon is not running.", start);
  } else if (!report.daemon.responsive) {
    add("daemon-unresponsive", "error", "The daemon accepts connections but did not answer.", "exocortexd restart");
  }
  const signedIn = report.providers
    ? Object.entries(report.providers).filter(([, provider]) => provider.authenticated && provider.source !== "public")
    : [];
  if (report.providers && signedIn.length === 0) {
    add("no-provider-login", "error", "No model provider is signed in.", report.claudeCode.found ? "exocortexd login anthropic   (or: exocortexd login openai)" : "exocortexd login openai   (or install Claude Code and run: exocortexd login anthropic)");
  }
  if (!report.claudeCode.found) {
    add("claude-code-missing", "warning", "Claude Code is not installed; Claude models are unavailable.", "curl -fsSL https://claude.ai/install.sh | bash");
  } else if (!report.claudeCode.loggedIn && signedIn.length > 0) {
    // With nothing signed in, no-provider-login above already says this.
    add("claude-code-logged-out", "warning", "Claude Code is not signed in.", "exocortexd login anthropic");
  }
  if (!report.commands.exocortexd) {
    add("exocortexd-not-on-path", "warning", "`exocortexd` is not on PATH.", "Rerun the installer, then open a new shell");
  }
  if (report.daemon.service.manager !== "none" && !report.daemon.service.installed) {
    add("service-not-installed", "warning", "The daemon is not installed as a background service.", "Rerun the installer without --no-service");
  }
  if (report.macos) problems.push(...diagnoseMacos(report));
  return problems;
}

/**
 * macOS privacy: every file the daemon and its tools touch is attributed to
 * the process launchd started. Only the signed launcher app, with Full Disk
 * Access, keeps macOS from asking about each protected folder again.
 */
function diagnoseMacos(report: DoctorReport): DoctorProblem[] {
  const macos = report.macos!;
  const problems: DoctorProblem[] = [];
  const add = (id: string, message: string, fix: string) => problems.push({ id, severity: "warning", message, fix });
  const build = `${report.exocortex.repoDir}/scripts/macos/build-launcher.sh --reload   (from a terminal)`;
  const { service } = report.daemon;

  if (service.installed && macos.agentUsesLauncher === false) {
    add("launcher-not-used", "The LaunchAgent does not run Exocortex Daemon.app, so macOS asks about files on behalf of bash.", build);
  } else if (!macos.launcherInstalled && service.installed) {
    add("launcher-missing", `${macos.launcherApp} is not installed.`, build);
  }
  if (macos.launcherSigning === "adhoc" || macos.launcherSigning === "unsigned") {
    add("launcher-adhoc", "Exocortex Daemon.app has no signing identity, so macOS forgets its privacy grants whenever it is rebuilt.",
      `Create an Apple Development certificate (Xcode › Settings › Accounts › Manage Certificates), then: ${build}`);
  }
  if (service.installed && service.active === false && report.daemon.running) {
    add("daemon-outside-launchagent", "The daemon is running outside its LaunchAgent, so macOS attributes its file access to the terminal that started it.",
      "Stop that daemon (Ctrl+C in its terminal), then: exocortexd start");
  }
  if (macos.fullDiskAccess === "missing") {
    add("full-disk-access-missing", "Exocortex Daemon has no Full Disk Access, so macOS asks separately about Desktop, Documents, Downloads and other apps' data.",
      `${report.exocortex.repoDir}/scripts/macos/full-disk-access.sh setup   (switch on "Exocortex Daemon", then exocortexd restart)`);
  }
  return problems;
}

// ── Output ───────────────────────────────────────────────────────────

export function formatDoctorReport(report: DoctorReport, color = false): string {
  const paint = (code: string, text: string) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const good = paint("32", "✓"), bad = paint("31", "✗"), warn = paint("33", "!"), info = "•";
  const lines = ["", "  Exocortex doctor", ""];
  const { exocortex, bun, claudeCode, daemon, providers, commands } = report;

  const revision = [exocortex.commit, exocortex.branch].filter(Boolean).join(", ");
  lines.push(`  ${exocortex.dependencies ? good : bad} Exocortex ${exocortex.version ?? "?"}${revision ? ` (${revision})` : ""}  ${exocortex.repoDir}`);
  lines.push(`  ${good} Bun ${bun.version}  ${bun.path}`);
  if (claudeCode.found) {
    const login = claudeCode.loggedIn ? `signed in${claudeCode.email ? ` as ${claudeCode.email}` : ""}` : "not signed in";
    lines.push(`  ${claudeCode.loggedIn ? good : warn} Claude Code ${claudeCode.version ?? "?"}, ${login}  ${claudeCode.path}`);
  } else {
    lines.push(`  ${warn} Claude Code not installed`);
  }

  const service = daemon.service.installed
    ? `${daemon.service.manager} ${daemon.service.name}${daemon.service.active === false ? " (inactive)" : ""}`
    : "no service";
  const state = daemon.responsive ? "running" : daemon.running ? "not answering" : "not running";
  lines.push(`  ${daemon.responsive ? good : bad} Daemon ${state}${daemon.pid ? ` (pid ${daemon.pid})` : ""}, ${service}`);
  lines.push(`    socket: ${daemon.socket}`);

  if (providers) {
    const signedIn = Object.entries(providers)
      .filter(([, provider]) => provider.authenticated && provider.source !== "public")
      .map(([id, provider]) => provider.email ? `${id} (${provider.email})` : id);
    lines.push(`  ${signedIn.length > 0 ? good : bad} Providers: ${signedIn.length > 0 ? signedIn.join(", ") : "none signed in"}`);
  }
  lines.push(`  ${info} TUI: ${commands.tui ? commands.tui : "not installed (add it: exocortexd install-tui)"}`);
  if (report.macos) {
    const { launcherInstalled, launcherSigning, fullDiskAccess } = report.macos;
    const access = fullDiskAccess === "granted" ? "Full Disk Access" : fullDiskAccess === "missing" ? "no Full Disk Access" : "Full Disk Access unknown";
    const fine = launcherInstalled && launcherSigning === "identity" && fullDiskAccess === "granted";
    lines.push(`  ${fine ? good : warn} Launcher: ${launcherInstalled ? `${launcherSigning === "identity" ? "signed" : launcherSigning}, ${access}` : "not installed"}  ${report.macos.launcherApp}`);
  }

  if (report.problems.length > 0) {
    lines.push("");
    for (const problem of report.problems) {
      lines.push(`  ${problem.severity === "error" ? bad : warn} ${problem.message}`);
      lines.push(`    fix: ${problem.fix}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
