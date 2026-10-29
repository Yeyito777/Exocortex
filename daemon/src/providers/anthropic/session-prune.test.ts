import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  applyClaudeSessionPrune,
  claudeProjectDirName,
  claudeSessionAlias,
  ensureClaudeTranscriptRetention,
  chainAncestry,
  planClaudeSessionPrune,
  purgeQuarantine,
  quarantineRoot,
  readAliases,
  restoreQuarantine,
  type ConversationResumePoints,
} from "./session-prune";

const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 9, 29, 12);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): { root: string; projects: string; workspaces: string } {
  const root = mkdtempSync(join(tmpdir(), "claude-prune-"));
  dirs.push(root);
  const projects = join(root, "claude", "projects");
  mkdirSync(projects, { recursive: true });
  return { root, projects, workspaces: join(root, "data", "workspaces") };
}

const sid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

/** A transcript: entries `uuid<-parent` in file order (parent "" starts a chain, as a compaction boundary does). */
function writeSession(dir: string, sessionId: string, chain: string[], options: { ageDays?: number; entrypoint?: string } = {}): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  const lines = chain.map((link) => {
    const [uuid, parent] = link.split("<-");
    return JSON.stringify({ parentUuid: parent || null, isSidechain: false, type: "user", uuid, sessionId, entrypoint: options.entrypoint ?? "sdk-ts" });
  });
  writeFileSync(path, `${JSON.stringify({ type: "queue-operation", sessionId })}\n${lines.join("\n")}\n`);
  const at = (NOW - (options.ageDays ?? 3) * DAY) / 1000;
  utimesSync(path, at, at);
  return path;
}

function conversation(workspaces: string, convId: string, points: Array<[number, string]>): ConversationResumePoints {
  const cwd = join(workspaces, convId);
  return { convId, points: points.map(([n, resumeAt]) => ({ sessionId: sid(n), resumeAt, cwd })) };
}

describe("claudeProjectDirName", () => {
  test("names project directories as Claude Code does", () => {
    expect(claudeProjectDirName("/home/u/Workspace/exocortex/config/data/workspaces/1791667824123-k14mhj"))
      .toBe("-home-u-Workspace-exocortex-config-data-workspaces-1791667824123-k14mhj");
    const long = `/${"a".repeat(250)}`;
    // Past 200 characters Claude Code keeps 200 and adds a hash of the path.
    expect(claudeProjectDirName(long)).toMatch(new RegExp(`^-a{199}-[0-9a-z]+$`));
  });
});

describe("chainAncestry", () => {
  test("follows the last entry's parents, stops at a compaction boundary, and tells histories apart", () => {
    const { projects } = scratch();
    const path = writeSession(projects, sid(1), ["a<-", "b<-a", "dead<-b", "boundary<-", "c<-boundary", "d<-c"]);
    expect([...chainAncestry(path).keys()].sort()).toEqual(["boundary", "c", "d"]);
    // The same entry under another history (a compaction's preserved tail) hashes differently.
    const original = writeSession(projects, sid(2), ["a<-", "x<-a", "y<-x"]);
    const compacted = writeSession(projects, sid(3), ["summary<-", "x<-summary", "y<-x"]);
    const copy = writeSession(projects, sid(4), ["a<-", "x<-a", "y<-x", "z<-y"]);
    expect(chainAncestry(compacted).get("y")).not.toBe(chainAncestry(original).get("y"));
    expect(chainAncestry(copy).get("y")).toBe(chainAncestry(original).get("y"));
    expect([...chainAncestry(copy, new Set(["x"])).keys()]).toEqual(["x"]);
  });

  test("in the file of the process that compacted, follows the boundary's branch, not the command left on the old chain", () => {
    const { projects } = scratch();
    const path = join(projects, `${sid(5)}.jsonl`);
    const entry = (uuid: string, parentUuid: string | null, extra: Record<string, unknown> = {}) => JSON.stringify({ uuid, parentUuid, isSidechain: false, type: "user", ...extra });
    writeFileSync(path, [
      entry("a", null), entry("b", "a"),
      entry("boundary", null, { type: "system", subtype: "compact_boundary" }), entry("summary", "boundary"),
      entry("command", "b"), entry("stdout", "command"), entry("attachment", "stdout", { type: "attachment" }),
    ].join("\n") + "\n");
    expect([...chainAncestry(path).keys()].sort()).toEqual(["boundary", "summary"]);
  });
});

describe("planClaudeSessionPrune", () => {
  const convId = "1791667824123-k14mhj";

  test("keeps the next turn's session, aliases the forks it holds, and deletes them", () => {
    const { projects, workspaces } = scratch();
    const dir = join(projects, claudeProjectDirName(join(workspaces, convId)));
    // Each fork copies the chain up to its resume point and adds its turn.
    writeSession(dir, sid(1), ["a<-", "b<-a"]);
    writeSession(dir, sid(2), ["a<-", "b<-a", "c<-b", "d<-c"]);
    writeSession(dir, sid(3), ["a<-", "b<-a", "c<-b", "d<-c", "e<-d", "f<-e"]);
    const plan = planClaudeSessionPrune({
      conversations: [conversation(workspaces, convId, [[1, "b"], [2, "d"], [3, "f"]])],
      projectsRoots: [projects], workspacesRoot: workspaces, now: NOW,
    });
    expect(plan.keep.files).toBe(1);
    expect(plan.remove.map(file => file.path.split("/").pop()).sort()).toEqual([`${sid(1)}.jsonl`, `${sid(2)}.jsonl`]);
    expect(plan.remove.every(file => file.reason === "superseded")).toBe(true);
    expect(plan.aliases).toEqual({ [sid(1)]: sid(3), [sid(2)]: sid(3) });
  });

  test("keeps an older fork that holds points from before a compaction", () => {
    const { projects, workspaces } = scratch();
    const dir = join(projects, claudeProjectDirName(join(workspaces, convId)));
    writeSession(dir, sid(1), ["a<-", "b<-a"]);
    writeSession(dir, sid(2), ["a<-", "b<-a", "c<-b"]);
    // The process of session 3 compacted: its loaded chain starts at the boundary.
    writeSession(dir, sid(3), ["boundary<-", "d<-boundary", "e<-d"]);
    writeSession(dir, sid(4), ["boundary<-", "d<-boundary", "e<-d", "f<-e"]);
    const plan = planClaudeSessionPrune({
      conversations: [conversation(workspaces, convId, [[1, "b"], [2, "c"], [3, "e"], [4, "f"]])],
      projectsRoots: [projects], workspacesRoot: workspaces, now: NOW,
    });
    expect(plan.remove.map(file => file.path.split("/").pop()).sort()).toEqual([`${sid(1)}.jsonl`, `${sid(3)}.jsonl`]);
    expect(plan.aliases).toEqual({ [sid(1)]: sid(2), [sid(3)]: sid(4) });
  });

  test("does not alias a point to a file that holds it under a compacted history", () => {
    const { projects, workspaces } = scratch();
    const dir = join(projects, claudeProjectDirName(join(workspaces, convId)));
    writeSession(dir, sid(1), ["a<-", "b<-a"]);
    // Compacted after b, keeping b after the summary.
    writeSession(dir, sid(2), ["summary<-", "b<-summary", "c<-b"]);
    const plan = planClaudeSessionPrune({
      conversations: [conversation(workspaces, convId, [[1, "b"], [2, "c"]])],
      projectsRoots: [projects], workspacesRoot: workspaces, now: NOW,
    });
    expect(plan.remove).toEqual([]);
    expect(plan.aliases).toEqual({});
  });

  test("judges a session an earlier prune moved through the file its alias named", () => {
    const { projects, workspaces } = scratch();
    const dir = join(projects, claudeProjectDirName(join(workspaces, convId)));
    // Session 1 was moved earlier, aliased to 2; 3 now holds everything.
    writeSession(dir, sid(2), ["a<-", "b<-a"]);
    writeSession(dir, sid(3), ["a<-", "b<-a", "c<-b"]);
    const plan = planClaudeSessionPrune({
      conversations: [conversation(workspaces, convId, [[1, "a"], [2, "b"], [3, "c"]])],
      projectsRoots: [projects], workspacesRoot: workspaces, now: NOW, previousAliases: { [sid(1)]: sid(2) },
    });
    expect(plan.aliases).toEqual({ [sid(1)]: sid(3), [sid(2)]: sid(3) });
    expect(plan.remove.map(file => file.path.split("/").pop())).toEqual([`${sid(2)}.jsonl`]);
  });

  test("never deletes a session a process holds or one written within the grace period", () => {
    const { projects, workspaces } = scratch();
    const dir = join(projects, claudeProjectDirName(join(workspaces, convId)));
    writeSession(dir, sid(1), ["a<-"], { ageDays: 3 });
    writeSession(dir, sid(2), ["a<-", "b<-a"], { ageDays: 0.5 });
    writeSession(dir, sid(3), ["a<-", "b<-a", "c<-b"], { ageDays: 3 });
    // A running process's new fork: no point recorded yet.
    writeSession(dir, sid(9), ["a<-", "b<-a", "c<-b", "x<-c"], { ageDays: 3 });
    const plan = planClaudeSessionPrune({
      conversations: [conversation(workspaces, convId, [[1, "a"], [2, "b"], [3, "c"]])],
      projectsRoots: [projects], workspacesRoot: workspaces, now: NOW, protectedSessions: new Set([sid(9)]),
    });
    expect(plan.remove.map(file => file.path.split("/").pop())).toEqual([`${sid(1)}.jsonl`]);
    expect(plan.held.files).toBe(2);
  });

  test("deletes unreferenced files Exocortex wrote, never an interactive Claude Code session", () => {
    const { projects, workspaces } = scratch();
    const dir = join(projects, claudeProjectDirName(join(workspaces, convId)));
    writeSession(dir, sid(1), ["a<-"]);
    writeSession(dir, sid(5), ["z<-"]);
    writeSession(dir, sid(6), ["y<-"], { entrypoint: "cli" });
    const plan = planClaudeSessionPrune({
      conversations: [conversation(workspaces, convId, [[1, "a"]])],
      projectsRoots: [projects], workspacesRoot: workspaces, now: NOW,
    });
    expect(plan.remove.map(file => [file.path.split("/").pop(), file.reason])).toEqual([[`${sid(5)}.jsonl`, "unreferenced"]]);
  });

  test("removes a deleted conversation's directory once quiet, and leaves other instances' and the owner's directories", () => {
    const { root, projects, workspaces } = scratch();
    const gone = join(projects, claudeProjectDirName(join(workspaces, "1790000000000-gone01")));
    writeSession(gone, sid(1), ["a<-"], { ageDays: 10 });
    const recent = join(projects, claudeProjectDirName(join(workspaces, "1790000000000-gone02")));
    writeSession(recent, sid(2), ["a<-"], { ageDays: 2 });
    // In the trash: still in the store, so kept.
    const trashed = join(projects, claudeProjectDirName(join(workspaces, "1790000000000-trash1")));
    writeSession(trashed, sid(3), ["a<-"], { ageDays: 40 });
    const elsewhere = join(projects, claudeProjectDirName(join(root, "other", "workspaces", "1790000000000-other1")));
    writeSession(elsewhere, sid(4), ["a<-"], { ageDays: 40 });
    const owner = join(projects, claudeProjectDirName("/home/u/Workspace/exocortex"));
    writeSession(owner, sid(5), ["a<-"], { ageDays: 40 });
    const plan = planClaudeSessionPrune({
      conversations: [
        conversation(workspaces, "1790000000000-trash1", [[3, "a"]]),
        { convId: "1790000000000-cwd001", points: [{ sessionId: sid(5), resumeAt: "a", cwd: "/home/u/Workspace/exocortex" }] },
      ],
      projectsRoots: [projects], workspacesRoot: workspaces, now: NOW,
    });
    expect(plan.remove.map(file => [file.path, file.reason])).toEqual([[gone, "conversation-gone"]]);
    expect(plan.outOfScope).toEqual({ conversations: 1, points: 1 });
  });

  test("keeps the sessions another conversation resumes in this workspace", () => {
    const { projects, workspaces } = scratch();
    const dir = join(projects, claudeProjectDirName(join(workspaces, convId)));
    writeSession(dir, sid(1), ["a<-"]);
    writeSession(dir, sid(2), ["b<-"]);
    const plan = planClaudeSessionPrune({
      conversations: [
        conversation(workspaces, convId, [[1, "a"]]),
        { convId: "1790000000000-guest1", points: [{ sessionId: sid(2), resumeAt: "b", cwd: join(workspaces, convId) }] },
      ],
      projectsRoots: [projects], workspacesRoot: workspaces, now: NOW,
    });
    expect(plan.remove).toEqual([]);
    expect(plan.keep.files).toBe(2);
  });
});

describe("applyClaudeSessionPrune", () => {
  const convId = "1791667824123-k14mhj";

  function forks(projects: string, workspaces: string) {
    const dir = join(projects, claudeProjectDirName(join(workspaces, convId)));
    return {
      dir,
      first: writeSession(dir, sid(1), ["a<-"]),
      second: writeSession(dir, sid(2), ["a<-", "b<-a"]),
      third: writeSession(dir, sid(3), ["a<-", "b<-a", "c<-b"]),
    };
  }

  test("writes the aliases first, moves files to the quarantine, and skips a file written since the plan", () => {
    const { root, projects, workspaces } = scratch();
    const { dir, first, second } = forks(projects, workspaces);
    const plan = planClaudeSessionPrune({
      conversations: [conversation(workspaces, convId, [[1, "a"], [2, "b"], [3, "c"]])],
      projectsRoots: [projects], workspacesRoot: workspaces, now: NOW,
    });
    // Resumed (and so written) between plan and apply.
    utimesSync(second, NOW / 1000, NOW / 1000);
    const aliasesPath = join(root, "claude-session-aliases.json");
    const result = applyClaudeSessionPrune(plan, aliasesPath, new Set(), NOW);
    expect(result).toMatchObject({ removedFiles: 1, skipped: 1, errors: [] });
    expect(existsSync(first)).toBe(false);
    const quarantined = join(quarantineRoot(projects), "2026-10-29", claudeProjectDirName(join(workspaces, convId)), `${sid(1)}.jsonl`);
    expect(existsSync(quarantined)).toBe(true);
    expect(existsSync(second)).toBe(true);
    expect(quarantineRoot(projects)).toBe(join(root, "claude", "exocortex-prune-quarantine"));
    expect(claudeSessionAlias(aliasesPath, sid(1))).toBe(sid(3));
    expect(claudeSessionAlias(aliasesPath, sid(3))).toBeNull();
    expect(dir.startsWith(projects)).toBe(true);
  });

  test("a restore brings a day back, leaving what exists again; days past the retention are purged", () => {
    const { root, projects, workspaces } = scratch();
    const { first, second } = forks(projects, workspaces);
    const plan = planClaudeSessionPrune({
      conversations: [conversation(workspaces, convId, [[1, "a"], [2, "b"], [3, "c"]])],
      projectsRoots: [projects], workspacesRoot: workspaces, now: NOW,
    });
    applyClaudeSessionPrune(plan, join(root, "aliases.json"), new Set(), NOW);
    expect([existsSync(first), existsSync(second)]).toEqual([false, false]);
    writeFileSync(second, "written again\n");
    const restored = restoreQuarantine(projects, "2026-10-29");
    expect(restored.restored).toBe(1);
    expect(restored.conflicts).toEqual([second]);
    expect(existsSync(first)).toBe(true);
    expect(readFileSync(second, "utf8")).toBe("written again\n");

    const old = join(quarantineRoot(projects), "2026-10-21");
    const recent = join(quarantineRoot(projects), "2026-10-23");
    mkdirSync(old, { recursive: true });
    mkdirSync(recent, { recursive: true });
    expect(purgeQuarantine(quarantineRoot(projects), NOW)).toEqual([old]);
    expect(existsSync(recent)).toBe(true);
  });

  test("an alias outlives the history that named it, and goes with its target", () => {
    const { root, projects, workspaces } = scratch();
    forks(projects, workspaces);
    const aliasesPath = join(root, "aliases.json");
    applyClaudeSessionPrune(planClaudeSessionPrune({
      conversations: [conversation(workspaces, convId, [[1, "a"], [2, "b"], [3, "c"]])],
      projectsRoots: [projects], workspacesRoot: workspaces, now: NOW, previousAliases: readAliases(aliasesPath),
    }), aliasesPath, new Set(), NOW);
    expect(claudeSessionAlias(aliasesPath, sid(1))).toBe(sid(3));
    // An unwind dropped the points of sessions 1 and 2: their aliases stay while session 3 does.
    applyClaudeSessionPrune(planClaudeSessionPrune({
      conversations: [conversation(workspaces, convId, [[3, "c"]])],
      projectsRoots: [projects], workspacesRoot: workspaces, now: NOW, previousAliases: readAliases(aliasesPath),
    }), aliasesPath, new Set(), NOW);
    expect(claudeSessionAlias(aliasesPath, sid(1))).toBe(sid(3));
    // Session 3 superseded by 4, which holds every point: the aliases follow.
    writeSession(join(projects, claudeProjectDirName(join(workspaces, convId))), sid(4), ["a<-", "b<-a", "c<-b", "d<-c"]);
    applyClaudeSessionPrune(planClaudeSessionPrune({
      conversations: [conversation(workspaces, convId, [[1, "a"], [2, "b"], [3, "c"], [4, "d"]])],
      projectsRoots: [projects], workspacesRoot: workspaces, now: NOW, previousAliases: readAliases(aliasesPath),
    }), aliasesPath, new Set(), NOW);
    expect([1, 2, 3].map(n => claudeSessionAlias(aliasesPath, sid(n)))).toEqual([sid(4), sid(4), sid(4)]);
  });

  test("moves a deleted conversation's whole directory", () => {
    const { root, projects, workspaces } = scratch();
    const name = claudeProjectDirName(join(workspaces, "1790000000000-gone01"));
    writeSession(join(projects, name), sid(1), ["a<-"], { ageDays: 10 });
    const plan = planClaudeSessionPrune({ conversations: [], projectsRoots: [projects], workspacesRoot: workspaces, now: NOW });
    const result = applyClaudeSessionPrune(plan, join(root, "aliases.json"), new Set(), NOW);
    expect(result.removedFiles).toBe(1);
    expect(existsSync(join(projects, name))).toBe(false);
    expect(existsSync(join(quarantineRoot(projects), "2026-10-29", name, `${sid(1)}.jsonl`))).toBe(true);
  });
});

describe("ensureClaudeTranscriptRetention", () => {
  test("sets a long period where none is set, once for linked accounts, and keeps an explicit one", () => {
    const { root } = scratch();
    const main = join(root, ".claude");
    const max2 = join(root, ".claude-max2");
    const other = join(root, ".claude-other");
    for (const dir of [main, max2, other]) mkdirSync(dir);
    writeFileSync(join(main, "settings.json"), JSON.stringify({ model: "opus", theme: "dark" }, null, 2));
    symlinkSync(join(main, "settings.json"), join(max2, "settings.json"));
    writeFileSync(join(other, "settings.json"), JSON.stringify({ cleanupPeriodDays: 60 }));
    const results = ensureClaudeTranscriptRetention([main, max2, other]);
    expect(results.map(r => r.outcome)).toEqual(["set", "already-set"]);
    expect(JSON.parse(readFileSync(join(main, "settings.json"), "utf8"))).toEqual({ model: "opus", theme: "dark", cleanupPeriodDays: 3650 });
    // Written through the link, which stays a link.
    expect(readFileSync(join(max2, "settings.json"), "utf8")).toBe(readFileSync(join(main, "settings.json"), "utf8"));
    expect(ensureClaudeTranscriptRetention([main]).map(r => r.outcome)).toEqual(["already-set"]);
  });

  test("leaves a settings file it cannot read alone", () => {
    const { root } = scratch();
    const main = join(root, ".claude");
    mkdirSync(main);
    writeFileSync(join(main, "settings.json"), "{ // not JSON");
    expect(ensureClaudeTranscriptRetention([main]).map(r => r.outcome)).toEqual(["unreadable"]);
    expect(readFileSync(join(main, "settings.json"), "utf8")).toBe("{ // not JSON");
  });
});
