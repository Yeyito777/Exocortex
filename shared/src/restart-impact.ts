import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Decides whether the files changed between the running daemon's commit and
 * disk HEAD can alter the running daemon. Anything unclear answers "restart".
 */

export type PathClass = "restart" | "ignore" | "source";

const SOURCE = /\.(?:[cm]?[jt]s|tsx)$/;
// Test-only sources: test/ dirs, *.test.* and the *.cases.* bodies test wrappers run in child processes.
const TEST = /(?:^|\/)test\/|\.(?:test|cases)\.[cm]?[jt]sx?$/;
const ROOT_RUNTIME_FILES = new Set(["package.json", "bun.lock", "bun.lockb", "bunfig.toml", "tsconfig.json"]);
// Everything the daemon (or its service wrapper) reads, execs or installs from.
const RUNTIME_DIRS = ["daemon/", "shared/", "config/", "bin/", "external-tools/", "helper-tools/", "scripts/setup/"];
const IRRELEVANT_DIRS = ["docs/", "tui/", "scripts/dev/", "scripts/windows/", "scripts/migrate/"];

/**
 * "source": module code, relevant only if the daemon imports it (and then only
 *   if its runtime output changed). "restart": loaded or read by the daemon in
 *   a way we don't trace. "ignore": cannot affect it. Unknown paths restart.
 */
export function classifyChangedPath(path: string): PathClass {
  if (TEST.test(path)) return "ignore";
  if (SOURCE.test(path)) return "source";
  if (ROOT_RUNTIME_FILES.has(path)) return "restart";
  if (RUNTIME_DIRS.some(dir => path.startsWith(dir))) return "restart";
  if (IRRELEVANT_DIRS.some(dir => path.startsWith(dir))) return "ignore";
  if (!path.includes("/") && (path.endsWith(".md") || path === "LICENSE" || path === "Makefile" || path === ".gitignore")) return "ignore";
  return "restart";
}

/** Types and comments never reach the runtime, so a change that vanishes here is inert. */
export function runtimeFingerprint(path: string, source: string): string {
  const loader = path.endsWith("x") ? "tsx" : /\.[cm]?js$/.test(path) ? "js" : "ts";
  return new Bun.Transpiler({ loader }).transformSync(source);
}

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

async function sourceFiles(root: string, dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") out.push(...await sourceFiles(root, path));
    } else if (SOURCE.test(entry.name) && !TEST.test(path)) {
      out.push(path);
    }
  }
  return out;
}

/** Repo-relative source files reachable from the daemon: every non-test daemon file plus what they import. */
export async function daemonImportClosure(root: string): Promise<Set<string>> {
  const exportsMap = (JSON.parse(await readFile(join(root, "shared/package.json"), "utf8")) as { exports?: Record<string, string> }).exports ?? {};
  const exists = async (path: string) => {
    try { await readFile(join(root, path)); return true; } catch { return false; }
  };
  const resolve = async (from: string, specifier: string): Promise<string | null> => {
    let base: string;
    if (specifier.startsWith(".")) base = posix.normalize(posix.join(dirname(from), specifier));
    else if (specifier.startsWith("@exocortex/shared/")) {
      const target = exportsMap[`./${specifier.slice("@exocortex/shared/".length)}`];
      if (!target) return null;
      base = posix.join("shared", target);
    } else return null;
    if (base.startsWith("..")) return null;
    const stem = base.replace(/\.[cm]?js$/, "");
    for (const candidate of [base, `${stem}.ts`, `${stem}.tsx`, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
      if (SOURCE.test(candidate) && await exists(candidate)) return candidate;
    }
    return null;
  };
  const closure = new Set<string>();
  const queue = await sourceFiles(root, "daemon");
  while (queue.length) {
    const file = queue.pop()!;
    if (closure.has(file)) continue;
    closure.add(file);
    let text: string;
    try { text = await readFile(join(root, file), "utf8"); } catch { continue; }
    for (const match of text.matchAll(SPECIFIER)) {
      const target = await resolve(file, match[1]!);
      if (target && !closure.has(target)) queue.push(target);
    }
  }
  return closure;
}

async function git(root: string, args: string[], maxBuffer = 16 * 1024 * 1024): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root, timeout: 10_000, maxBuffer,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" },
  });
  return stdout;
}

async function show(root: string, commit: string, path: string): Promise<string | null> {
  try { return await git(root, ["show", `${commit}:${path}`]); } catch { return null; }
}

/** Does a source file's runtime output differ between two commits? A missing side counts as different. */
async function sourceChanged(root: string, from: string, to: string, path: string): Promise<boolean> {
  const [before, after] = await Promise.all([show(root, from, path), show(root, to, path)]);
  if (before === null || after === null) return true;
  try {
    return runtimeFingerprint(path, before) !== runtimeFingerprint(path, after);
  } catch {
    return true;
  }
}

/**
 * True when anything between two commits can change the running daemon.
 * `closure` is the import closure of `to`. Any failure answers true.
 */
export async function changesAffectDaemon(root: string, from: string, to: string, closure: Set<string>): Promise<boolean> {
  try {
    if (from === to) return false;
    const paths = (await git(root, ["diff", "--name-only", "--no-renames", "-z", from, to])).split("\0").filter(Boolean);
    const sources: string[] = [];
    for (const path of paths) {
      const kind = classifyChangedPath(path);
      if (kind === "restart") return true;
      // A daemon file absent from `to` was deleted; its importers changed too, but don't rely on that.
      if (kind === "source" && (closure.has(path) || path.startsWith("daemon/"))) sources.push(path);
    }
    for (let at = 0; at < sources.length; at += 8) {
      const changed = await Promise.all(sources.slice(at, at + 8).map(path => sourceChanged(root, from, to, path)));
      if (changed.includes(true)) return true;
    }
    return false;
  } catch {
    return true;
  }
}
