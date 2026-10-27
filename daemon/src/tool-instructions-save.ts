/**
 * save_tool_instructions: write edited /instructions tools blocks back to
 * where they are stored, then commit and push them.
 *
 * A built-in tool's block is its daemon/src/tools/text/<tool>.<kind>.md in
 * the checkout this daemon runs from; an external tool's is the systemHint of
 * its manifest.json, rewritten in place so the rest of the file keeps its
 * bytes. Every edit is checked before anything is written, so a refused save
 * changes nothing. Each repository then gets one commit of exactly the paths
 * written (other agents share these checkouts and may have staged work), a
 * pull --rebase when its upstream moved, and a push. A failed commit, pull or
 * push keeps the written files (and any local commit) and is reported.
 */

import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "fs";
import { basename, dirname, join, relative } from "path";
import type { ToolInstructionsCommit, ToolInstructionsEdit } from "@exocortex/shared/protocol";
import type { ModelId, ProviderId } from "./messages";
import { log } from "./log";
import { reloadExternalToolsNow } from "./external-tools";
import { describeToolTextTargets, type ToolTextTarget } from "./tool-instructions";
import { invalidateToolText } from "./tools/tool-text";
import { expandTemplate, retemplate } from "./tools/tool-text-template";

const MAX_EDITS = 100;
const MAX_TEXT_CHARS = 64 * 1024;
const GIT_LOCAL_TIMEOUT_MS = 30_000;
const GIT_NETWORK_TIMEOUT_MS = 90_000;

export class ToolInstructionsSaveError extends Error {}

export interface ToolInstructionsSaveResult {
  saved: Array<{ id: string; text: string }>;
  commits: ToolInstructionsCommit[];
}

/** The text as it will be stored: no leading blank lines or trailing whitespace. */
export function normalizeToolText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "");
}

function validateEdits(edits: unknown): ToolInstructionsEdit[] {
  if (!Array.isArray(edits) || edits.length === 0) throw new ToolInstructionsSaveError("Nothing to save");
  if (edits.length > MAX_EDITS) throw new ToolInstructionsSaveError(`Too many edits at once (${edits.length}; at most ${MAX_EDITS})`);
  const seen = new Set<string>();
  return edits.map((edit: unknown) => {
    const { id, text, expected } = (edit ?? {}) as Partial<ToolInstructionsEdit>;
    if (typeof id !== "string" || !id || typeof text !== "string" || typeof expected !== "string") {
      throw new ToolInstructionsSaveError("Malformed edit: each needs an id, text and expected text");
    }
    if (seen.has(id)) throw new ToolInstructionsSaveError(`${id} is edited twice`);
    seen.add(id);
    if (text.length > MAX_TEXT_CHARS) throw new ToolInstructionsSaveError(`${id} is too long (${text.length} characters; at most ${MAX_TEXT_CHARS})`);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new ToolInstructionsSaveError(`${id} contains control characters`);
    return { id, text, expected };
  });
}

/** What a block is, for messages and the commit: "exo hint", "cal hint", "bash description". */
function blockName(target: ToolTextTarget): string {
  if (target.store.kind === "manifest") return `${target.tool} hint`;
  return `${target.tool} ${target.store.textKind}`;
}

// ── Manifests ────────────────────────────────────────────────────────

/** Where a top-level string property's value (quotes included) sits in raw JSON. */
export function findTopLevelString(raw: string, key: string): { start: number; end: number } | null {
  let depth = 0;
  let i = 0;
  const readString = (from: number): number => {
    let j = from + 1;
    while (j < raw.length) {
      if (raw[j] === "\\") j += 2;
      else if (raw[j] === "\"") return j + 1;
      else j++;
    }
    return -1;
  };
  while (i < raw.length) {
    const char = raw[i];
    if (char === "\"") {
      const end = readString(i);
      if (end === -1) return null;
      if (depth === 1) {
        let after = end;
        while (/\s/.test(raw[after] ?? "")) after++;
        if (raw[after] === ":" && JSON.parse(raw.slice(i, end)) === key) {
          let value = after + 1;
          while (/\s/.test(raw[value] ?? "")) value++;
          if (raw[value] !== "\"") return null;
          const valueEnd = readString(value);
          return valueEnd === -1 ? null : { start: value, end: valueEnd };
        }
      }
      i = end;
      continue;
    }
    if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
    i++;
  }
  return null;
}

/** The manifest with only its systemHint replaced; throws rather than return a broken one. */
export function replaceManifestSystemHint(raw: string, hint: string, path: string): string {
  let before: Record<string, unknown>;
  try {
    before = JSON.parse(raw);
  } catch (error) {
    throw new ToolInstructionsSaveError(`${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}); not touching it`);
  }
  if (!before || typeof before !== "object" || Array.isArray(before) || typeof before.systemHint !== "string") {
    throw new ToolInstructionsSaveError(`${path} has no string systemHint; not touching it`);
  }
  const span = findTopLevelString(raw, "systemHint");
  if (!span) throw new ToolInstructionsSaveError(`Could not find systemHint in ${path}; not touching it`);
  const next = raw.slice(0, span.start) + JSON.stringify(hint) + raw.slice(span.end);
  const after = JSON.parse(next) as Record<string, unknown>;
  if (after.systemHint !== hint || JSON.stringify({ ...before, systemHint: hint }) !== JSON.stringify(after)) {
    throw new ToolInstructionsSaveError(`Rewriting ${path} would change more than its systemHint; not touching it`);
  }
  return next;
}

// ── Files ────────────────────────────────────────────────────────────

/** Write via a temporary file and rename, keeping the file's mode. */
function writeAtomically(path: string, content: string): void {
  const real = existsSync(path) ? realpathSync(path) : path;
  const temp = join(dirname(real), `.${basename(real)}.${process.pid}.${Date.now()}.tmp`);
  const mode = existsSync(real) ? statSync(real).mode & 0o7777 : 0o644;
  writeFileSync(temp, content, { mode });
  renameSync(temp, real);
}

interface PlannedWrite {
  target: ToolTextTarget;
  /** The new stored text (template). */
  template: string;
  /** The file's new content. */
  content: string;
}

function plan(target: ToolTextTarget, text: string): PlannedWrite {
  const normalized = normalizeToolText(text);
  if (!normalized && !target.allowEmpty) throw new ToolInstructionsSaveError(`The ${blockName(target)} can't be empty`);
  const template = retemplate(target.template, target.tokens, target.text, normalized);
  if (target.store.kind === "file") return { target, template, content: template ? `${template}\n` : "" };
  const raw = readFileSync(target.path, "utf-8");
  return { target, template, content: replaceManifestSystemHint(raw, template, target.path) };
}

// ── Git ──────────────────────────────────────────────────────────────

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function git(cwd: string, args: string[], timeoutMs = GIT_LOCAL_TIMEOUT_MS): Promise<GitResult> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    // Never wait on a credential or passphrase prompt nobody can answer.
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
  };
  const child = Bun.spawn(["git", ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() || (code === 0 ? "" : `git ${args[0]} exited with ${child.signalCode ?? code}`) };
  } finally {
    clearTimeout(timer);
  }
}

/** The last meaningful line of git's complaint. */
function gitError(step: string, result: GitResult): string {
  const lines = result.stderr.split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("hint:"));
  const detail = (lines.find(line => /^(error|fatal|!)/.test(line)) ?? lines.at(-1) ?? "failed").replace(/^(error|fatal): /, "");
  return `${step} failed: ${detail}`;
}

/** Saves to one repository run one at a time. */
const repoQueues = new Map<string, Promise<unknown>>();

function inRepoQueue<T>(repo: string, run: () => Promise<T>): Promise<T> {
  const previous = repoQueues.get(repo) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  repoQueues.set(repo, next);
  void next.finally(() => {
    if (repoQueues.get(repo) === next) repoQueues.delete(repo);
  });
  return next;
}

async function commitAndPush(repo: string, paths: string[], message: string): Promise<ToolInstructionsCommit> {
  // New files (a hint a tool did not have) must be known to git before `commit -- paths`.
  const add = await git(repo, ["add", "--", ...paths]);
  if (!add.ok) return { repo, commit: null, pushed: false, error: gitError("git add", add) };
  const changed = await git(repo, ["diff", "--cached", "--quiet", "--", ...paths]);
  if (changed.ok) return { repo, commit: null, pushed: false, error: "Nothing to commit: the files already had this text" };
  // Only these paths: other staged work in a shared checkout stays staged.
  const commit = await git(repo, ["commit", "--quiet", "-m", message, "--", ...paths]);
  if (!commit.ok) return { repo, commit: null, pushed: false, error: gitError("git commit", commit) };
  const hash = (await git(repo, ["rev-parse", "--short", "HEAD"])).stdout || null;

  const upstream = await git(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!upstream.ok) return { repo, commit: hash, pushed: false, error: "Not pushed: this branch has no upstream" };
  const fetch = await git(repo, ["fetch", "--quiet"], GIT_NETWORK_TIMEOUT_MS);
  if (!fetch.ok) return { repo, commit: hash, pushed: false, error: gitError("git fetch", fetch) };
  const behind = await git(repo, ["rev-list", "--count", "HEAD..@{u}"]);
  let head = hash;
  if (behind.ok && Number(behind.stdout) > 0) {
    // Others' uncommitted work is set aside for the rebase and put back after.
    const pull = await git(repo, ["pull", "--rebase", "--autostash", "--quiet"], GIT_NETWORK_TIMEOUT_MS);
    if (!pull.ok) {
      await git(repo, ["rebase", "--abort"]);
      return { repo, commit: hash, pushed: false, error: `${gitError("git pull --rebase", pull)}; the commit is kept locally` };
    }
    head = (await git(repo, ["rev-parse", "--short", "HEAD"])).stdout || hash;
  }
  const push = await git(repo, ["push", "--quiet"], GIT_NETWORK_TIMEOUT_MS);
  if (!push.ok) return { repo, commit: head, pushed: false, error: `${gitError("git push", push)}; the commit is kept locally` };
  return { repo, commit: head, pushed: true };
}

async function repoOf(path: string): Promise<string | null> {
  const dir = dirname(existsSync(path) ? realpathSync(path) : path);
  const top = await git(existsSync(dir) ? realpathSync(dir) : dir, ["rev-parse", "--show-toplevel"]);
  return top.ok && top.stdout ? top.stdout : null;
}

// ── Save ─────────────────────────────────────────────────────────────

export async function saveToolInstructions(
  route: { provider: ProviderId; model: ModelId | null; convId?: string },
  rawEdits: unknown,
  force = false,
): Promise<ToolInstructionsSaveResult> {
  const edits = validateEdits(rawEdits);
  const { targets } = describeToolTextTargets(route.provider, route.model, route.convId);

  // Check everything before writing anything.
  const writes = edits.map((edit) => {
    const target = targets.get(edit.id);
    if (!target) throw new ToolInstructionsSaveError(`${edit.id} is not tool text on this route`);
    if (!force && target.text !== edit.expected) {
      throw new ToolInstructionsSaveError(`The ${blockName(target)} changed since you opened it; :w! overwrites`);
    }
    return plan(target, edit.text);
  });

  const written: PlannedWrite[] = [];
  for (const write of writes) {
    if (write.template === write.target.template) continue;
    writeAtomically(write.target.path, write.content);
    if (write.target.store.kind === "file") invalidateToolText(write.target.path);
    written.push(write);
  }
  if (written.some(write => write.target.store.kind === "manifest")) reloadExternalToolsNow();
  const saved = writes.map(write => ({ id: write.target.id, text: expandTemplate(write.template, write.target.tokens) }));

  const byRepo = new Map<string, PlannedWrite[]>();
  const commits: ToolInstructionsCommit[] = [];
  for (const write of written) {
    const repo = await repoOf(write.target.path);
    if (!repo) {
      commits.push({ repo: dirname(write.target.path), commit: null, pushed: false, error: "Not committed: not in a git repository" });
      continue;
    }
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), write]);
  }
  for (const [repo, repoWrites] of byRepo) {
    const paths = repoWrites.map(write => relative(repo, realpathSync(write.target.path)));
    const message = `instructions: edit ${repoWrites.map(write => blockName(write.target)).join(", ")} via /instructions tools`;
    const result = await inRepoQueue(repo, () => commitAndPush(repo, paths, message));
    log(result.error ? "warn" : "info", `tool-instructions: ${message} in ${repo}: ${result.commit ?? "no commit"}${result.pushed ? ", pushed" : ""}${result.error ? ` (${result.error})` : ""}`);
    commits.push(result);
  }
  return { saved, commits };
}
