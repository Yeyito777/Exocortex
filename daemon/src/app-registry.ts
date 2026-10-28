/**
 * App conversations (docs/app-api.md): what makes a conversation an app's.
 *
 * Each app conversation has a record: its app, lifetime, system prompt,
 * built-in and app tools, and working directory. Records of saved and
 * temporary conversations persist in a small file beside the conversation
 * store (`app-conversations.json` in the instance's data directory), so
 * ordinary conversations keep exactly their storage; ephemeral ones live only
 * here, in memory. The conversation store asks this module which
 * conversations are hidden (temporary and ephemeral) and which are never
 * written (ephemeral). Kept free of heavy imports so the store can use it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "@exocortex/shared/paths";
import type { AppLifetime, AppSystemBase, AppToolDef } from "@exocortex/shared/app-api";
import type { TurnResultEvent } from "@exocortex/shared/protocol";
import { log } from "./log";

export interface AppConversationRecord {
  convId: string;
  app: string;
  lifetime: AppLifetime;
  createdAt: number;
  /** Last command naming it or turn end; temporary ones expire `idleTtlMs` after it. */
  lastActivityAt: number;
  /** temporary only. */
  idleTtlMs?: number;
  system: { text: string; base: AppSystemBase };
  /** App-supplied working directory: never created, moved or deleted by the daemon. */
  cwd?: string;
  /** Daemon-created temporary working directory of an ephemeral conversation without `cwd`. */
  ephemeralWorkspace?: string;
  /** Neutral built-in tool names as requested ("all" = what an ordinary conversation gets). */
  builtin: string[] | "all";
  appTools: AppToolDef[];
  /** The most recent turn_result (without reqId), for an owner attaching after its turn ended. */
  lastTurnResult?: TurnResultEvent;
}

interface RegistryFile {
  version: 1;
  conversations: Record<string, AppConversationRecord>;
}

const records = new Map<string, AppConversationRecord>();
let fileOverride: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const SAVE_DEBOUNCE_MS = 1_000;

export function appRegistryPath(): string {
  return fileOverride ?? join(dataDir(), "app-conversations.json");
}

/** Tests point the registry at a scratch file. */
export function setAppRegistryPathForTests(path: string | null): void {
  fileOverride = path;
}

/** Forget every record (tests). */
export function resetAppRegistryForTests(): void {
  records.clear();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
}

function isRecord(value: unknown): value is AppConversationRecord {
  const record = value as AppConversationRecord | null;
  return typeof record?.convId === "string" && typeof record.app === "string"
    && (record.lifetime === "saved" || record.lifetime === "temporary")
    && typeof record.createdAt === "number" && typeof record.lastActivityAt === "number"
    && typeof record.system?.text === "string" && typeof record.system.base === "string"
    && (record.builtin === "all" || Array.isArray(record.builtin)) && Array.isArray(record.appTools);
}

/** Read the saved and temporary records; ephemeral ones from an earlier daemon are gone with it. */
export function loadAppRegistry(): number {
  for (const [id, record] of records) if (record.lifetime !== "ephemeral") records.delete(id);
  const path = appRegistryPath();
  if (!existsSync(path)) return 0;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as RegistryFile;
    for (const [id, record] of Object.entries(parsed.conversations ?? {})) {
      if (isRecord(record) && record.convId === id) records.set(id, record);
      else log("warn", `app-registry: ignoring an invalid record for ${id}`);
    }
  } catch (error) {
    log("error", `app-registry: could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return records.size;
}

function writeNow(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  const conversations: Record<string, AppConversationRecord> = {};
  for (const record of records.values()) {
    if (record.lifetime !== "ephemeral") conversations[record.convId] = record;
  }
  const path = appRegistryPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ version: 1, conversations } satisfies RegistryFile), { mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function scheduleWrite(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { writeNow(); } catch (error) {
      log("error", `app-registry: could not save: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

/** Write any pending activity times (shutdown). */
export function flushAppRegistry(): void {
  if (saveTimer) writeNow();
}

/**
 * Record a new app conversation before the conversation itself is created, so
 * a hidden one is never briefly an ordinary one. Throws when it cannot be saved.
 */
export function registerAppConversation(record: AppConversationRecord): void {
  records.set(record.convId, record);
  if (record.lifetime === "ephemeral") return;
  try {
    writeNow();
  } catch (error) {
    records.delete(record.convId);
    throw error;
  }
}

export function removeAppConversationRecord(convId: string): boolean {
  const record = records.get(convId);
  if (!record) return false;
  records.delete(convId);
  if (record.lifetime !== "ephemeral") {
    try { writeNow(); } catch (error) {
      log("error", `app-registry: could not save after removing ${convId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return true;
}

export function getAppRecord(convId: string): AppConversationRecord | undefined {
  return records.get(convId);
}

export function listAppRecords(): AppConversationRecord[] {
  return [...records.values()];
}

export function isAppConversation(convId: string): boolean {
  return records.has(convId);
}

/** Temporary and ephemeral conversations: never in the sidebar or any TUI broadcast. */
export function isHiddenConversation(convId: string): boolean {
  const lifetime = records.get(convId)?.lifetime;
  return lifetime === "temporary" || lifetime === "ephemeral";
}

/** Memory only: never written to the conversation store or any journal. */
export function isEphemeralConversation(convId: string): boolean {
  return records.get(convId)?.lifetime === "ephemeral";
}

/** The working directory an app conversation's tools run in, when it is not the usual workspace. */
export function appWorkingDirectory(convId: string): string | undefined {
  const record = records.get(convId);
  return record?.cwd ?? record?.ephemeralWorkspace;
}

/** Something happened on it: a command naming it or a turn ending. */
export function touchAppConversation(convId: string, now = Date.now()): void {
  const record = records.get(convId);
  if (!record || now <= record.lastActivityAt) return;
  record.lastActivityAt = now;
  if (record.lifetime !== "ephemeral") scheduleWrite();
}

export function setAppTools(convId: string, appTools: AppToolDef[]): void {
  const record = records.get(convId);
  if (!record) return;
  record.appTools = appTools;
  if (record.lifetime !== "ephemeral") writeNow();
}

export function setLastTurnResult(convId: string, result: TurnResultEvent): void {
  const record = records.get(convId);
  if (!record) return;
  record.lastTurnResult = result;
  if (record.lifetime !== "ephemeral") scheduleWrite();
}

/** When a temporary conversation expires unless something happens on it first. */
export function appConversationExpiresAt(record: AppConversationRecord): number | undefined {
  return record.lifetime === "temporary" && record.idleTtlMs !== undefined
    ? record.lastActivityAt + record.idleTtlMs
    : undefined;
}
