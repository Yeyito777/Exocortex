#!/usr/bin/env bun
/**
 * test-select — which test files a change can affect, for `bun run check --changed`.
 *
 * Usage:
 *   bun scripts/dev/test-select.ts [--base REF | --commit SHA] [--explain FILE] [--json]
 *
 * A test file is picked when the change touches it or anything it reaches:
 * - its imports, static and dynamic (Bun's own scan, so type-only imports,
 *   which never run, don't count), through relative paths and the
 *   @exocortex/* workspace packages;
 * - files it names in a string, like a daemon or TUI entry point it spawns
 *   ("daemon/src/main.ts", join(import.meta.dir, "bash-runner.ts")) or a
 *   prompt it reads ("browse.hint.md", "../../docs/README.md"), and from there
 *   their imports too;
 * - a data file in a directory it names ("text" for tools/text/*.md).
 *
 * It picks every test, and says why, when it can't tell: no diff base, a
 * package, lock, bunfig or tsconfig file, the test setup (test/), check.ts or
 * this file, a file deleted or renamed inside shared/, daemon/ or tui/, or a
 * file there that's neither code nor named by any code. Files outside the
 * packages that no code names (docs, clients, external tools) pick nothing.
 *
 * The default base is where this branch left origin/main, plus uncommitted
 * and untracked files. --commit SHA selects for that one commit (graph as of
 * that commit), for replaying history.
 */

import { readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
export const SUITES = ["shared", "daemon", "tui"] as const;
export type Suite = (typeof SUITES)[number];

export interface Change { status: string; path: string; from?: string }
export interface Selection {
  /** Why every test runs; undefined when the selection below applies. */
  all?: string;
  /** Test files per suite, relative to the suite directory. */
  suites: Record<Suite, string[]>;
  /** Packages whose typecheck the change can affect (all three when `all` is set). */
  typecheck: Suite[];
  /** For the report: what picked the tests. */
  why: string[];
}

// ── Reading a tree ────────────────────────────────────────────────

/** All tracked (and, for the working tree, untracked) files with a way to read them. */
export interface Tree { files: string[]; read(path: string): string }

function git(args: string[], input?: string): string {
  const run = Bun.spawnSync(["git", ...args], { cwd: ROOT, stdin: input === undefined ? "ignore" : Buffer.from(input), stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString().trim()}`);
  return run.stdout.toString();
}

export function workingTree(): Tree {
  const files = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean);
  return { files, read: path => { try { return readFileSync(join(ROOT, path), "utf8"); } catch { return ""; } } };
}

/** The tree of a commit; source files read in one `git cat-file --batch`. */
export function commitTree(sha: string): Tree {
  const files = git(["ls-tree", "-r", "-z", "--name-only", sha]).split("\0").filter(Boolean);
  const wanted = files.filter(isScanned);
  const out = Bun.spawnSync(["git", "cat-file", "--batch"], {
    cwd: ROOT, stdin: Buffer.from(wanted.map(f => `${sha}:${f}`).join("\n") + "\n"), stdout: "pipe",
  }).stdout;
  const contents = new Map<string, string>();
  let offset = 0;
  for (const file of wanted) {
    const headerEnd = out.indexOf(10, offset);
    const size = Number(out.subarray(offset, headerEnd).toString().split(" ")[2]);
    contents.set(file, out.subarray(headerEnd + 1, headerEnd + 1 + size).toString("utf8"));
    offset = headerEnd + 1 + size + 1;
  }
  return { files, read: path => contents.get(path) ?? "" };
}

// ── The graph ─────────────────────────────────────────────────────

const CODE = /\.(?:[cm]?[jt]sx?)$/;
const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const isScanned = (path: string) => CODE.test(path) && !path.includes("node_modules/");
const inPackage = (path: string) => SUITES.some(suite => path.startsWith(`${suite}/`));

export interface Graph {
  files: Set<string>;
  dirs: Set<string>;
  /** Files each code file reaches directly: imports and named files. */
  edges: Map<string, Set<string>>;
  /** Directories each code file names. */
  dirEdges: Map<string, Set<string>>;
  /** Code in shared/, daemon/ or tui/ whose imports couldn't be read. */
  unparsed: string[];
}

/** "@exocortex/shared/paths" → shared/src/paths.ts, from each workspace package's exports. */
function packageExports(tree: Tree): Map<string, string> {
  const map = new Map<string, string>();
  for (const suite of SUITES) {
    let pkg: { name?: string; exports?: Record<string, string> };
    try { pkg = JSON.parse(tree.read(`${suite}/package.json`)); } catch { continue; }
    if (!pkg.name) continue;
    for (const [key, target] of Object.entries(pkg.exports ?? {})) {
      if (typeof target !== "string") continue;
      map.set(posix.join(pkg.name, key), posix.join(suite, target));
    }
  }
  return map;
}

const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"];

function resolveImport(from: string, spec: string, files: Set<string>, exports: Map<string, string>): string | undefined {
  let base: string;
  if (spec.startsWith(".")) base = posix.join(posix.dirname(from), spec);
  else if (exports.has(spec)) return exports.get(spec);
  else return undefined;
  for (const ext of EXTENSIONS) if (files.has(base + ext)) return base + ext;
  if (base.endsWith(".js") && files.has(base.slice(0, -3) + ".ts")) return base.slice(0, -3) + ".ts";
  return undefined;
}

/** Strings in the source that look like a path: no spaces, the part after a template's last ${…}, without ./ ../ or /. */
function pathStrings(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/(["'`])([^"'`\s\\]{1,200})\1/g)) {
    let text = match[2];
    const brace = text.lastIndexOf("}");
    if (brace >= 0) text = text.slice(brace + 1);
    text = text.replace(/^(?:\.{1,2}\/)+/, "").replace(/^\/+/, "").replace(/\/+$/, "");
    if (text && !text.startsWith("$")) found.add(text);
  }
  return [...found];
}

/** Every trailing piece of a path: a/b/c.md → c.md, b/c.md, a/b/c.md. */
function suffixes(path: string): string[] {
  const parts = path.split("/");
  return parts.map((_, i) => parts.slice(i).join("/"));
}

export function buildGraph(tree: Tree): Graph {
  const files = new Set(tree.files);
  const dirs = new Set<string>();
  for (const file of files) for (let d = posix.dirname(file); d !== "."; d = posix.dirname(d)) dirs.add(d);
  // Path suffix → the files and directories it can name.
  const bySuffix = new Map<string, string[]>();
  const dirsBySuffix = new Map<string, string[]>();
  for (const file of files) for (const s of suffixes(file)) bySuffix.set(s, [...(bySuffix.get(s) ?? []), file]);
  for (const dir of dirs) for (const s of suffixes(dir)) dirsBySuffix.set(s, [...(dirsBySuffix.get(s) ?? []), dir]);

  const exports = packageExports(tree);
  const transpilers = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }), js: new Bun.Transpiler({ loader: "js" }), jsx: new Bun.Transpiler({ loader: "jsx" }) };
  const unparsed: string[] = [];
  const edges = new Map<string, Set<string>>();
  const dirEdges = new Map<string, Set<string>>();
  for (const file of files) {
    if (!isScanned(file)) continue;
    const source = tree.read(file);
    const out = new Set<string>();
    const outDirs = new Set<string>();
    let imports: { path: string }[] = [];
    const ext = /\.([cm]?)([jt]sx?)$/.exec(file)![2] as keyof typeof transpilers;
    // The scan rejects a #! line.
    try { imports = transpilers[ext].scanImports(source.replace(/^#!.*/, "")); } catch { if (inPackage(file)) unparsed.push(file); }
    for (const { path } of imports) {
      const target = resolveImport(file, path, files, exports);
      if (target) out.add(target);
    }
    const pkg = file.split("/")[0];
    for (const text of pathStrings(source)) {
      // A name that fits several files means the ones in this file's own package if any fit
      // ("src/main.ts" in the daemon is the daemon's).
      let targets = bySuffix.get(text) ?? [];
      if (targets.length > 1 && targets.some(t => t.startsWith(`${pkg}/`))) targets = targets.filter(t => t.startsWith(`${pkg}/`));
      // Code named by its bare file name is beside this file (join(import.meta.dir, "x.ts")); elsewhere
      // a bare "index.ts" is only a name. Data files ("system.base.md") can be anywhere.
      if (!text.includes("/")) targets = targets.filter(t => !CODE.test(t) || posix.dirname(t) === posix.dirname(file));
      for (const target of targets) if (target !== file) out.add(target);
      // A bare word names a directory only beside this file ("text" for ./text/).
      const named = dirsBySuffix.get(text) ?? [];
      for (const dir of named) if (text.includes("/") || posix.dirname(dir) === posix.dirname(file)) outDirs.add(dir);
    }
    edges.set(file, out);
    dirEdges.set(file, outDirs);
  }
  return { files, dirs, edges, dirEdges, unparsed };
}

/** Everything a file reaches, itself included: for checking the graph against coverage. */
export function reach(graph: Graph, file: string): Set<string> {
  const seen = new Set([file]);
  const queue = [file];
  while (queue.length) for (const next of graph.edges.get(queue.pop()!) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  return seen;
}

// ── Selection ─────────────────────────────────────────────────────

const RUN_ALL: [RegExp, string][] = [
  [/(^|\/)(package\.json|bun\.lockb?|bunfig\.toml|tsconfig[^/]*\.json)$/, "a package, lock, bunfig or tsconfig file changed"],
  [/^test\/(?!timings\/)/, "the test setup (test/) changed"],
  [/^scripts\/dev\/(check|test-select)\.ts$/, "check.ts or test-select.ts changed"],
];
const NO_TESTS = [/^test\/timings\//];

export function select(changes: Change[], tree: Tree, explain?: string): Selection {
  const why: string[] = [];
  const empty = (): Record<Suite, string[]> => ({ shared: [], daemon: [], tui: [] });
  for (const change of changes) {
    for (const [pattern, reason] of RUN_ALL) if (pattern.test(change.path)) return { all: `${reason}: ${change.path}`, suites: empty(), typecheck: [...SUITES], why };
    const gone = change.status.startsWith("D") ? change.path : change.status.startsWith("R") ? change.from : undefined;
    if (gone && inPackage(gone)) return { all: `a file was deleted or renamed: ${gone}`, suites: empty(), typecheck: [...SUITES], why };
  }

  const graph = buildGraph(tree);
  if (graph.unparsed.length) return { all: `couldn't read the imports of ${graph.unparsed[0]}`, suites: empty(), typecheck: [...SUITES], why };
  // Reverse edges: who reaches each file, and who names each directory.
  const reachedBy = new Map<string, string[]>();
  for (const [from, targets] of graph.edges) for (const to of targets) reachedBy.set(to, [...(reachedBy.get(to) ?? []), from]);
  const dirNamedBy = new Map<string, string[]>();
  for (const [from, dirs] of graph.dirEdges) for (const dir of dirs) dirNamedBy.set(dir, [...(dirNamedBy.get(dir) ?? []), from]);

  const start = new Set<string>();
  for (const change of changes) {
    const path = change.path;
    if (NO_TESTS.some(pattern => pattern.test(path))) continue;
    if (graph.edges.has(path)) { start.add(path); continue; }
    // Not code: whatever names it, or a directory it's in, is what it affects.
    const namers = new Set(reachedBy.get(path) ?? []);
    for (let d = posix.dirname(path); d !== "."; d = posix.dirname(d)) for (const f of dirNamedBy.get(d) ?? []) namers.add(f);
    if (namers.size) { for (const f of namers) start.add(f); continue; }
    if (inPackage(path) && !TEST.test(path)) return { all: `no code names ${path}`, suites: empty(), typecheck: [...SUITES], why };
  }

  // Each affected file and the file through which the change reached it.
  const via = new Map<string, string | null>([...start].map(file => [file, null]));
  const queue = [...start];
  while (queue.length) {
    const file = queue.shift()!;
    for (const from of reachedBy.get(file) ?? []) if (!via.has(from)) { via.set(from, file); queue.push(from); }
  }
  const affected = new Set(via.keys());
  if (explain) {
    const chain: string[] = [];
    for (let f: string | null | undefined = explain; f; f = via.get(f)) chain.push(f);
    why.push(via.has(explain) ? `${explain} is reached by: ${chain.join(" <- ")}` : `${explain} is not reached`);
  }
  const suites = empty();
  for (const file of affected) {
    if (!TEST.test(file)) continue;
    const suite = SUITES.find(s => file.startsWith(`${s}/`));
    if (suite) suites[suite].push(file.slice(suite.length + 1));
  }
  for (const suite of SUITES) suites[suite].sort();
  // tsc follows imports, type-only ones too: a package is checked when its own
  // code changed or code in a package it imports from did.
  const changedPackages = new Set(changes.filter(c => CODE.test(c.path)).map(c => SUITES.find(s => c.path.startsWith(`${s}/`))).filter(Boolean));
  const typecheck = SUITES.filter(pkg => changedPackages.has(pkg) || [...changedPackages].some(other => importsFrom(tree, pkg, other!)));
  why.push(`${changes.length} changed file${changes.length === 1 ? " reaches" : "s reach"} ${SUITES.map(s => `${suites[s].length} ${s}`).join(", ")} test files`);
  return { suites, typecheck, why };
}

/** Whether code in package `pkg` imports anything from package `other` ("../../tui/src/…", "@exocortex/shared/…"). */
function importsFrom(tree: Tree, pkg: Suite, other: Suite): boolean {
  if (pkg === other) return true;
  const pattern = new RegExp(`(?:from|import\\(|require\\()\\s*["'](?:(?:\\.\\./)+${other}/|@exocortex/${other}\\b|exocortex-${other}\\b)`);
  return tree.files.some(file => file.startsWith(`${pkg}/`) && isScanned(file) && pattern.test(tree.read(file)));
}

// ── Changes ───────────────────────────────────────────────────────

function parseNameStatus(text: string): Change[] {
  const fields = text.split("\0").filter(Boolean);
  const changes: Change[] = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    if (status.startsWith("R") || status.startsWith("C")) changes.push({ status, from: fields[i++], path: fields[i++] });
    else changes.push({ status, path: fields[i++] });
  }
  return changes;
}

/** Changes since BASE (default: where HEAD left origin/main) in the working tree, untracked files included. */
export function workingChanges(base?: string): Change[] {
  const ref = base ?? git(["merge-base", "HEAD", "origin/main"]).trim();
  const changes = parseNameStatus(git(["diff", "--name-status", "-z", "-M", ref]));
  for (const path of git(["ls-files", "-z", "--others", "--exclude-standard"]).split("\0").filter(Boolean)) changes.push({ status: "A", path });
  return changes;
}

export function commitChanges(sha: string): Change[] {
  return parseNameStatus(git(["diff-tree", "--no-commit-id", "--name-status", "-z", "-r", "-M", `${sha}^`, sha]));
}

// ── CLI ───────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const sha = flag("--commit");
  const explain = flag("--explain");
  const selection = sha ? select(commitChanges(sha), commitTree(sha), explain) : select(workingChanges(flag("--base")), workingTree(), explain);
  if (args.includes("--json")) console.log(JSON.stringify(selection));
  else if (selection.all) console.log(`all tests: ${selection.all}`);
  else {
    console.log(selection.why.join("\n"));
    for (const suite of SUITES) for (const file of selection.suites[suite]) console.log(`  ${suite}/${file}`);
  }
}

