#!/usr/bin/env bun
/**
 * Build/verify/clean a read-only real-conversation migration fixture.
 *
 * Source files are never opened for write. Destination is the current worktree's
 * namespaced, gitignored dataDir. Live automation and active work are excluded.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { dataDir } from "../../shared/src/paths";

interface LiveSummary {
  id: string;
  provider: string;
  model: string;
  effort: string;
  fastMode: boolean;
  messageCount: number;
  goal: unknown;
  marked: boolean;
  pinned: boolean;
  folderId: string | null;
  streaming: boolean;
  subagentCount: number;
  backgroundTaskCount: number;
  tasks?: Array<{ kind?: string }>;
}

interface StructuralFlags {
  empty: boolean;
  small: boolean;
  medium: boolean;
  multiMegabyte: boolean;
  toolUse: boolean;
  toolResult: boolean;
  failedToolResult: boolean;
  image: boolean;
  systemInstructions: boolean;
  folder: boolean;
  marked: boolean;
  pinned: boolean;
  nonDefaultSettings: boolean;
  activeContext: boolean;
  compaction: boolean;
  contextAttribution: boolean;
  legacyVersion: boolean;
  multiplePages: boolean;
}

interface Candidate {
  summary: LiveSummary;
  path: string;
  size: number;
  mtimeMs: number;
  version: number;
  storedMessageCount: number;
  flags: StructuralFlags;
}

interface ManifestFile {
  sourcePath: string;
  destinationPath: string;
  bytes: number;
  sourceMtimeMs: number;
  sha256: string;
}

interface FixtureManifest {
  version: 1;
  createdAt: number;
  sourceDataDir: string;
  destinationDataDir: string;
  currentConversationId: string;
  liveSnapshot: { conversationCount: number; streamingCount: number; runningJobCount: number };
  exclusions: Record<string, string[]>;
  selected: Array<{
    id: string;
    bytes: number;
    provider: string;
    model: string;
    effort: string;
    fastMode: boolean;
    messageCount: number;
    storedMessageCount: number;
    version: number;
    flags: StructuralFlags;
  }>;
  files: ManifestFile[];
  includedFolderIds: string[];
}

const TARGET = dataDir();
const FIXTURE_DIR = join(TARGET, "sqlite-fixture");
const MANIFEST_PATH = join(FIXTURE_DIR, "manifest.json");
const CURRENT_CONVERSATION_ID = process.env.EXOCORTEX_CONVERSATION_ID ?? "1785451035032-yqb8ll";

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function runExo(args: string[]): any {
  const result = Bun.spawnSync(["exo", ...args, "--json"], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`Cannot safely inspect live main daemon via exo ${args.join(" ")}: ${result.stderr.toString().trim()}`);
  }
  return JSON.parse(result.stdout.toString());
}

function collectConversationRefs(value: unknown, refs = new Set<string>(), key = ""): Set<string> {
  if (typeof value === "string") {
    if (/conversationid|convid|ownerconversationid|parentconversationid|targetconversationid/i.test(key)) refs.add(value);
    return refs;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectConversationRefs(item, refs, key);
    return refs;
  }
  if (!value || typeof value !== "object") return refs;
  for (const [childKey, child] of Object.entries(value)) collectConversationRefs(child, refs, childKey);
  return refs;
}

function readRequiredOrEmpty(path: string, required: boolean): any {
  if (!existsSync(path)) {
    if (required) throw new Error(`Required exclusion source is missing: ${path}`);
    return null;
  }
  try { return readJson(path); } catch (error) {
    throw new Error(`Cannot safely read exclusion source ${path}: ${error}`);
  }
}

function contentBlocks(messages: any[], type: string): any[] {
  return messages.flatMap((message) => Array.isArray(message?.content) ? message.content.filter((part: any) => part?.type === type) : []);
}

function classify(summary: LiveSummary, path: string): Candidate | null {
  try {
    const before = statSync(path);
    const raw = readJson(path);
    const after = statSync(path);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) return null;
    const messages = Array.isArray(raw.messages) ? raw.messages : [];
    const tools = contentBlocks(messages, "tool_use");
    const results = contentBlocks(messages, "tool_result");
    const flags: StructuralFlags = {
      empty: messages.length <= 1,
      small: before.size < 128 * 1024,
      medium: before.size >= 128 * 1024 && before.size < 2 * 1024 * 1024,
      multiMegabyte: before.size >= 2 * 1024 * 1024,
      toolUse: tools.length > 0,
      toolResult: results.length > 0,
      failedToolResult: results.some((part: any) => part.is_error === true),
      image: contentBlocks(messages, "image").length > 0,
      systemInstructions: messages.some((message: any) => message?.role === "system_instructions"),
      folder: summary.folderId != null,
      marked: summary.marked,
      pinned: summary.pinned,
      nonDefaultSettings: summary.fastMode || summary.effort !== "high" || !/gpt-5\.6-sol|deepseek-v4-pro/.test(summary.model),
      activeContext: raw.activeContext != null,
      compaction: messages.some((message: any) => message?.metadata?.kind === "context_compaction_finished") || raw.activeContext?.compactionCount > 0,
      contextAttribution: messages.some((message: any) => message?.contextTokens != null),
      legacyVersion: Number(raw.version ?? 1) < 18,
      multiplePages: summary.messageCount >= 20,
    };
    return { summary, path, size: before.size, mtimeMs: before.mtimeMs, version: Number(raw.version ?? 1), storedMessageCount: messages.length, flags };
  } catch {
    return null;
  }
}

function stableRank(id: string): number {
  return Number.parseInt(sha256(id).slice(0, 8), 16);
}

function chooseCandidates(eligible: LiveSummary[], sourceConversations: string): Candidate[] {
  const withStats = eligible.flatMap((summary) => {
    const path = join(sourceConversations, `${summary.id}.json`);
    try { return [{ summary, path, size: statSync(path).size }]; } catch { return []; }
  });
  const bySize = [...withStats].sort((a, b) => a.size - b.size);
  const pool = new Map<string, typeof withStats[number]>();
  const add = (items: typeof withStats) => items.forEach((item) => pool.set(item.summary.id, item));
  add(bySize.slice(0, 50));
  add(bySize.slice(-60));
  add(bySize.slice(Math.max(0, Math.floor(bySize.length / 2) - 30), Math.floor(bySize.length / 2) + 30));
  add(withStats.filter((item) => item.summary.provider !== "openai").slice(0, 60));
  add(withStats.filter((item) => item.summary.folderId || item.summary.marked || item.summary.pinned || item.summary.fastMode).slice(0, 100));
  add([...withStats].sort((a, b) => stableRank(a.summary.id) - stableRank(b.summary.id)).slice(0, 100));

  const classified = [...pool.values()].map((item) => classify(item.summary, item.path)).filter((item): item is Candidate => item !== null);
  const selected: Candidate[] = [];
  const selectedIds = new Set<string>();
  const desired = Object.keys(classified[0]?.flags ?? {}) as Array<keyof StructuralFlags>;
  const covered = new Set<keyof StructuralFlags>();
  const providerCovered = new Set<string>();

  while (selected.length < 24) {
    const remaining = classified.filter((candidate) => !selectedIds.has(candidate.summary.id));
    if (remaining.length === 0) break;
    remaining.sort((a, b) => {
      const score = (candidate: Candidate) =>
        desired.filter((flag) => candidate.flags[flag] && !covered.has(flag)).length * 100
        + (!providerCovered.has(candidate.summary.provider) ? 200 : 0)
        + (candidate.flags.multiMegabyte ? 20 : 0)
        + (candidate.flags.multiplePages ? 10 : 0);
      return score(b) - score(a) || stableRank(a.summary.id) - stableRank(b.summary.id);
    });
    const next = remaining[0];
    selected.push(next);
    selectedIds.add(next.summary.id);
    providerCovered.add(next.summary.provider);
    for (const flag of desired) if (next.flags[flag]) covered.add(flag);
  }
  if (selected.length < 20) throw new Error(`Only ${selected.length} safe/classifiable conversations were available; refusing an undersized fixture`);
  return selected;
}

function copyStable(source: string, destination: string): ManifestFile {
  const before = statSync(source);
  const sourceBytes = readFileSync(source);
  const sourceHash = sha256(sourceBytes);
  mkdirSync(resolve(destination, ".."), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination);
  const after = statSync(source);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    rmSync(destination, { force: true });
    throw new Error(`Source changed while copying: ${source}`);
  }
  const copied = readFileSync(destination);
  if (sha256(copied) !== sourceHash) throw new Error(`Destination hash mismatch: ${destination}`);
  return { sourcePath: source, destinationPath: destination, bytes: before.size, sourceMtimeMs: before.mtimeMs, sha256: sourceHash };
}

function filteredFolders(sourceData: string, selected: Candidate[]): { folders: any[]; instructions: Record<string, string>; ids: string[] } {
  const folderFile = readRequiredOrEmpty(join(sourceData, "folders.json"), false);
  const all = Array.isArray(folderFile?.folders) ? folderFile.folders : [];
  const byId = new Map(all.map((folder: any) => [String(folder.id), folder]));
  const ids = new Set<string>();
  for (const candidate of selected) {
    let id = candidate.summary.folderId;
    while (id && !ids.has(id)) {
      ids.add(id);
      id = byId.get(id)?.parentId ?? null;
    }
  }
  const instructionFile = readRequiredOrEmpty(join(sourceData, "folder-instructions.json"), false);
  const instructions = Object.fromEntries(Object.entries(instructionFile?.instructions ?? {}).filter(([id]) => ids.has(id)));
  return { folders: all.filter((folder: any) => ids.has(String(folder.id))), instructions, ids: [...ids] };
}

function createFixture(sourceData: string, replace: boolean): void {
  const source = resolve(sourceData);
  const sourceConversations = join(source, "conversations");
  if (!existsSync(sourceConversations)) throw new Error(`Source conversations directory is missing: ${sourceConversations}`);
  if (existsSync(join(TARGET, "exocortex.sqlite3")) && !replace) throw new Error(`Target already has a database; pass --replace to rebuild only ${TARGET}`);

  const live = runExo(["list"]) as LiveSummary[];
  const jobs = runExo(["jobs"]) as Array<{ id: string; running: boolean; streaming: boolean }>;
  if (!Array.isArray(live) || !Array.isArray(jobs)) throw new Error("Live daemon inspection returned an unexpected shape");

  const exclusionSets: Record<string, Set<string>> = {
    goals: new Set(live.filter((summary) => summary.goal != null).map((summary) => summary.id)),
    subscriptions: new Set(),
    chrono: new Set(),
    streaming: new Set(live.filter((summary) => summary.streaming).map((summary) => summary.id)),
    queued: new Set(),
    activeTasks: new Set(live.filter((summary) => summary.subagentCount > 0 || summary.backgroundTaskCount > 0 || (summary.tasks?.length ?? 0) > 0).map((summary) => summary.id)),
    subagentRecovery: new Set(),
    btw: new Set(),
    currentConversation: new Set([CURRENT_CONVERSATION_ID]),
  };
  for (const job of jobs) if (job.running || job.streaming) exclusionSets.streaming.add(job.id);

  const external = readRequiredOrEmpty(join(source, "external-notifications.json"), true);
  for (const subscription of external.subscriptions ?? []) if (typeof subscription.convId === "string") exclusionSets.subscriptions.add(subscription.convId);
  const chrono = readRequiredOrEmpty(join(source, "chrono.json"), true);
  collectConversationRefs(chrono, exclusionSets.chrono);
  const queue = readRequiredOrEmpty(join(source, "message-queue.json"), true);
  collectConversationRefs(queue, exclusionSets.queued);
  const subagentPath = join(source, "subagent-notifications.json");
  if (existsSync(subagentPath)) collectConversationRefs(readRequiredOrEmpty(subagentPath, false), exclusionSets.subagentRecovery);
  const btwPath = join(source, "btw.json");
  if (existsSync(btwPath)) {
    const btw = readRequiredOrEmpty(btwPath, false);
    for (const id of Object.keys(btw?.conversations ?? {})) exclusionSets.btw.add(id);
  }

  const excluded = new Set<string>();
  for (const ids of Object.values(exclusionSets)) for (const id of ids) excluded.add(id);
  const eligible = live.filter((summary) => !excluded.has(summary.id));
  const selected = chooseCandidates(eligible, sourceConversations);

  rmSync(TARGET, { recursive: true, force: true });
  mkdirSync(join(TARGET, "conversations"), { recursive: true, mode: 0o700 });
  mkdirSync(FIXTURE_DIR, { recursive: true, mode: 0o700 });
  const files: ManifestFile[] = [];
  for (const candidate of selected) {
    files.push(copyStable(candidate.path, join(TARGET, "conversations", basename(candidate.path))));
    for (const extension of ["sidebar", "unwind"]) {
      const overlay = join(sourceConversations, `${candidate.summary.id}.${extension}`);
      if (existsSync(overlay)) files.push(copyStable(overlay, join(TARGET, "conversations", basename(overlay))));
    }
  }

  const folderState = filteredFolders(source, selected);
  const folderBody = JSON.stringify({ version: 1, updatedAt: Date.now(), folders: folderState.folders }, null, 2);
  writeFileSync(join(TARGET, "folders.json"), folderBody, { mode: 0o600 });
  const instructionsBody = JSON.stringify({ version: 1, updatedAt: Date.now(), instructions: folderState.instructions }, null, 2);
  writeFileSync(join(TARGET, "folder-instructions.json"), instructionsBody, { mode: 0o600 });
  const sourceUnread = readRequiredOrEmpty(join(source, "unread.json"), false);
  const selectedIds = new Set(selected.map((candidate) => candidate.summary.id));
  const unread = (sourceUnread?.conversationIds ?? []).filter((id: string) => selectedIds.has(id));
  writeFileSync(join(TARGET, "unread.json"), JSON.stringify({ version: 1, updatedAt: Date.now(), conversationIds: unread }, null, 2), { mode: 0o600 });
  // Explicitly empty automation/queue state prevents accidental inheritance.
  writeFileSync(join(TARGET, "message-queue.json"), JSON.stringify({ version: 1, updatedAt: Date.now(), messages: [] }, null, 2), { mode: 0o600 });

  const manifest: FixtureManifest = {
    version: 1,
    createdAt: Date.now(),
    sourceDataDir: source,
    destinationDataDir: TARGET,
    currentConversationId: CURRENT_CONVERSATION_ID,
    liveSnapshot: {
      conversationCount: live.length,
      streamingCount: live.filter((summary) => summary.streaming).length,
      runningJobCount: jobs.filter((job) => job.running).length,
    },
    exclusions: Object.fromEntries(Object.entries(exclusionSets).map(([reason, ids]) => [reason, [...ids].sort()])),
    selected: selected.map((candidate) => ({
      id: candidate.summary.id,
      bytes: candidate.size,
      provider: candidate.summary.provider,
      model: candidate.summary.model,
      effort: candidate.summary.effort,
      fastMode: candidate.summary.fastMode,
      messageCount: candidate.summary.messageCount,
      storedMessageCount: candidate.storedMessageCount,
      version: candidate.version,
      flags: candidate.flags,
    })),
    files,
    includedFolderIds: folderState.ids.sort(),
  };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  // The immediate strict verification proves that this snapshot operation did not
  // mutate main. A later verification permits ordinary live-main drift while still
  // requiring the copied fixture bytes to match the immutable manifest.
  verifyFixture(true);
  console.log(JSON.stringify({ status: "created", manifest: MANIFEST_PATH, selected: manifest.selected, exclusionCounts: Object.fromEntries(Object.entries(exclusionSets).map(([key, ids]) => [key, ids.size])) }, null, 2));
}

function verifyFixture(requireSourceStable = false): string[] {
  if (!existsSync(MANIFEST_PATH)) throw new Error(`Fixture manifest is missing: ${MANIFEST_PATH}`);
  const manifest = readJson(MANIFEST_PATH) as FixtureManifest;
  if (manifest.selected.length < 20) throw new Error(`Fixture contains only ${manifest.selected.length} conversations`);
  const excluded = new Set(Object.values(manifest.exclusions).flat());
  for (const selected of manifest.selected) if (excluded.has(selected.id)) throw new Error(`Excluded conversation was selected: ${selected.id}`);
  const sourceDrift: string[] = [];
  for (const file of manifest.files) {
    if (sha256(readFileSync(file.destinationPath)) !== file.sha256) throw new Error(`Copied fixture hash mismatch: ${file.destinationPath}`);
    if (!existsSync(file.sourcePath)) {
      sourceDrift.push(file.sourcePath);
      continue;
    }
    const source = statSync(file.sourcePath);
    const stableMetadata = source.size === file.bytes && source.mtimeMs === file.sourceMtimeMs;
    const stableHash = stableMetadata && sha256(readFileSync(file.sourcePath)) === file.sha256;
    if (!stableHash) sourceDrift.push(file.sourcePath);
  }
  if (requireSourceStable && sourceDrift.length > 0) {
    throw new Error(`Main source changed during snapshot verification: ${sourceDrift[0]}`);
  }
  for (const forbidden of ["chrono.json", "external-notifications.json", "subagent-notifications.json", "btw.json", "external-notification-soft-wakes.json"]) {
    if (existsSync(join(TARGET, forbidden))) throw new Error(`Forbidden live automation state appears in fixture: ${forbidden}`);
  }
  console.error(`verified ${manifest.selected.length} safe conversations and ${manifest.files.length} immutable copied files; ${sourceDrift.length} live source file(s) changed after snapshot`);
  return sourceDrift;
}

function cleanupFixture(): void {
  rmSync(TARGET, { recursive: true, force: true });
  console.log(`removed worktree fixture only: ${TARGET}`);
}

const command = process.argv[2];
if (command === "create") {
  const sourceIndex = process.argv.indexOf("--source-data");
  const source = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : "/home/yeyito/Workspace/exocortex/config/data";
  createFixture(source, process.argv.includes("--replace"));
} else if (command === "verify") {
  const sourceDrift = verifyFixture(process.argv.includes("--require-source-stable"));
  console.log(JSON.stringify({ status: "verified", manifest: MANIFEST_PATH, sourceDriftCount: sourceDrift.length, sourceDrift }, null, 2));
} else if (command === "clean") {
  cleanupFixture();
} else {
  console.error("usage: sqlite-conversation-fixture.ts create [--source-data PATH] [--replace] | verify [--require-source-stable] | clean");
  process.exit(2);
}
