/**
 * Native implementation of the model-facing `exo` tool.
 *
 * The external exo-cli remains an IPC client for humans, scripts, and other
 * daemon instances. This runtime deliberately operates on the current daemon's
 * stores and orchestration hooks without a shell, subprocess, or loopback IPC.
 */

import { effectiveConversationDefaults } from "@exocortex/shared/config";
import { createHash } from "crypto";
import type { DisplayEntry, QueueTiming } from "@exocortex/shared/protocol";
import {
  MAX_ACTIVE_EXO_SUBAGENTS_GLOBAL,
  MAX_ACTIVE_EXO_SUBAGENTS_PER_PARENT,
  MAX_EXO_SUBAGENT_DEPTH,
  SUBAGENTS_FOLDER_NAME,
  type Block,
  type EffortLevel,
  type FolderSummary,
  type ModelId,
  type ProviderId,
  type SidebarItemRef,
} from "./messages";
import * as convStore from "./conversations";
import { complete } from "./llm";
import { log } from "./log";
import {
  allowsCustomModels,
  canonicalizeModel,
  getDefaultModel,
  getProvider,
  getProviders,
  isKnownModel,
  normalizeEffort,
  supportsFastMode,
} from "./providers/registry";
import { hasConfiguredCredentials } from "./auth";
import {
  broadcastConversationInstructionsUpdated,
  broadcastConversationUpdated,
  broadcastFolderInstructionsUpdated,
} from "./conversation-events";
import type { DaemonServer } from "./server";
import type { AssistantTurnOutcome } from "./orchestrator";
import type { ExocortexToolRuntime, ToolResult } from "./tools/types";
import { EXO_ACTIONS, type ExoAction } from "./tools/exo";
import { getTokenStatsSnapshot } from "./token-stats";
import {
  getActiveSubagentCount,
  getConversationActivityCounts,
  getSubagentConversationIds,
  listActiveConversationTasks,
  setSubagentActive,
  stopBackgroundTask,
  type ActiveConversationTask,
} from "./conversation-activity";
import { buildSystemPrompt, reloadUserAddendum, setUserAddendum } from "./system";
import { getLastUsage } from "./usage";

const runtimeByServer = new WeakMap<DaemonServer, ExocortexToolRuntime>();

/** Return the native runtime installed when this server's handler was built. */
export function getExocortexToolRuntime(server: DaemonServer): ExocortexToolRuntime | undefined {
  return runtimeByServer.get(server);
}

export interface ExocortexToolRuntimeDependencies {
  server: DaemonServer;
  runTurn(convId: string, text: string, maxDepth: number, startedAt: number): Promise<AssistantTurnOutcome>;
  /** Durable lifecycle hooks used by production. */
  beginParentNotification?(
    parent: { convId: string; maxChars?: number },
    childConvId: string,
    task: string,
    childStartedAt: number,
    subagentMaxDepth: number | null,
  ): unknown;
  completeParentNotification?(childConvId: string, outcome: AssistantTurnOutcome): void;
  /** Compatibility seam for isolated runtime tests without the durable manager. */
  notifyParent?(parentConvId: string, childConvId: string, task: string, outcome: AssistantTurnOutcome): void;
  /** Return a user-facing reason when a provider turn cannot currently start. */
  cannotStart?(provider: ProviderId): string | null;
  /** Dependency seams used by tests; production uses daemon auth and llm.complete. */
  hasCredentials?(provider: ProviderId): boolean;
  runCompletion?: typeof complete;
}

interface SidebarState {
  conversations: ReturnType<typeof convStore.listSummaries>;
  folders: FolderSummary[];
}

type FolderResolution =
  | { kind: "root"; folderId: null; path: "/" }
  | { kind: "folder"; folder: FolderSummary; folderId: string; path: string };

const LEGACY_ACTIONS = ["delete", "rename", "status", "llm", "folder_ls", "folder_tree", "folder_mkdir", "folder_mv", "folder_rm"] as const;
type LegacyExoAction = typeof LEGACY_ACTIONS[number];
type RuntimeExoAction = ExoAction | LegacyExoAction;
const VALID_ACTIONS = new Set<string>([...EXO_ACTIONS, ...LEGACY_ACTIONS]);

interface ExoCommandDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  examples?: Record<string, unknown>[];
  execute(args: Record<string, unknown>, parentConversationId: string | undefined, signal?: AbortSignal): Promise<ToolResult> | ToolResult;
}

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 200;

function ok(output: string): ToolResult {
  return { output, isError: false };
}

function fail(output: string): ToolResult {
  return { output, isError: true };
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function instructionRevision(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function stringInput(input: Record<string, unknown>, key: string, required = false): string | undefined {
  const value = input[key];
  const text = typeof value === "string" ? value.trim() : "";
  if (text) return text;
  if (required) {
    const scope = typeof input.action === "string" ? `action=${input.action}` : "this operation";
    throw new Error(`${key} is required for ${scope}`);
  }
  return undefined;
}

function booleanInput(input: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof input[key] === "boolean" ? input[key] : fallback;
}

function numberInput(input: Record<string, unknown>, key: string, fallback: number): number {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
}

function boundedIntegerInput(
  input: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Math.min(maximum, Math.max(minimum, numberInput(input, key, fallback)));
}

function requestedMaxDepth(input: Record<string, unknown>, callerMaxDepth: number | null | undefined): number {
  const value = input.max_depth;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`max_depth is required for action=${String(input.action)} and must be an integer from 0 to ${MAX_EXO_SUBAGENT_DEPTH}`);
  }
  if (value < 0 || value > MAX_EXO_SUBAGENT_DEPTH) {
    throw new Error(`max_depth must be between 0 and ${MAX_EXO_SUBAGENT_DEPTH}`);
  }
  if (callerMaxDepth != null) {
    if (callerMaxDepth <= 0) {
      throw new Error("This turn has max_depth=0 and cannot spawn or queue another subagent turn.");
    }
    const allowed = callerMaxDepth - 1;
    if (value > allowed) {
      throw new Error(`This turn has max_depth=${callerMaxDepth}; child max_depth must be between 0 and ${allowed}.`);
    }
  }
  return value;
}

function objectInput(input: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = input[key];
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

function conversationIdInput(args: Record<string, unknown>, parentConversationId: string | undefined): string {
  const convId = stringInput(args, "conversation_id") ?? parentConversationId;
  if (!convId) throw new Error("conversation_id is required when there is no active conversation context");
  return convId;
}

function subagentTitleInput(input: Record<string, unknown>): string {
  const title = stringInput(input, "title", true)!.replace(/\s+/g, " ").trim();
  const words = title.split(" ");
  if (title.length > 60 || words.length > 6) {
    throw new Error("title must be short (about three words, at most 6 words and 60 characters)");
  }
  return title;
}

function inferProviderForModel(model: string | undefined): ProviderId | undefined {
  const lowered = model?.trim().toLowerCase();
  if (!lowered) return undefined;
  if (lowered === "pro" || lowered === "flash" || lowered.startsWith("deepseek-") || lowered.startsWith("v4-")) return "deepseek";
  if (lowered.startsWith("gpt-") || lowered.startsWith("o1") || lowered.startsWith("o3") || lowered.startsWith("o4")) return "openai";
  return undefined;
}

function providerInput(value: unknown): ProviderId | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "openai" || value === "deepseek") return value;
  throw new Error(`Unknown provider: ${String(value)}`);
}

interface RequestedModel {
  provider?: ProviderId;
  model?: ModelId;
}

function parseRequestedModel(providerValue: unknown, modelValue: unknown): RequestedModel {
  let provider = providerInput(providerValue);
  let model = typeof modelValue === "string" && modelValue.trim() ? modelValue.trim() : undefined;

  if (model?.includes("/")) {
    const slash = model.indexOf("/");
    const specProvider = providerInput(model.slice(0, slash).trim().toLowerCase());
    const specModel = model.slice(slash + 1).trim();
    if (!specModel) throw new Error(`Missing model name in model spec: ${model}`);
    if (provider && specProvider && provider !== specProvider) {
      throw new Error(`Provider ${provider} conflicts with model spec provider ${specProvider}`);
    }
    provider = specProvider;
    model = specModel;
  }

  provider = provider ?? inferProviderForModel(model);
  if (provider && model) model = canonicalizeModel(provider, model);
  return { provider, model };
}

function unknownModelMessage(provider: ProviderId, model: string): string {
  const available = getProvider(provider)?.models.map(candidate => candidate.id).join(", ") || "none";
  return `Unknown model for provider ${provider}: ${model}. Available models: ${available}`;
}

interface ModelSelection {
  provider: ProviderId;
  model: ModelId;
  effort: EffortLevel;
  fastMode: boolean;
}

function resolveModelSelection(input: Record<string, unknown>): ModelSelection {
  const requested = parseRequestedModel(input.provider, input.model);
  const defaults = effectiveConversationDefaults();
  const provider = requested.provider ?? defaults.provider;
  if (!getProvider(provider)) throw new Error(`Unknown provider: ${provider}`);
  const model = requested.model
    ?? (provider === defaults.provider ? defaults.model : getDefaultModel(provider));
  if (!isKnownModel(provider, model) && !allowsCustomModels(provider)) {
    throw new Error(unknownModelMessage(provider, model));
  }
  const defaultEffort = provider === defaults.provider && model === defaults.model ? defaults.effort : undefined;
  const effort = normalizeEffort(provider, model, defaultEffort);
  const fastMode = provider === defaults.provider
    && model === defaults.model
    && defaults.fastMode
    && supportsFastMode(provider);
  return { provider, model, effort, fastMode };
}

function formatBlocks(blocks: Block[], full: boolean): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "tool_call") parts.push(`  ╸ ${block.summary}`);
    else if (block.type === "thinking" && full) parts.push(`  💭 ${block.text}`);
    else if (block.type === "tool_result" && full) {
      const prefix = block.isError ? "  ✗ " : "  ┃ ";
      parts.push(block.output.split("\n").map(line => prefix + line).join("\n"));
    }
  }
  return parts.join("\n").trim();
}

function formatHistoryEntries(entries: DisplayEntry[], full: boolean): string {
  const parts: string[] = [];
  for (const entry of entries) {
    if (entry.type === "user") {
      parts.push("▶ You", entry.text);
      if (entry.images?.length) parts.push(`[${entry.images.length} image attachment(s)]`);
    } else if (entry.type === "ai") {
      parts.push("▶ Assistant", formatBlocks(entry.blocks, full));
    } else if (entry.type === "system_instructions") {
      parts.push("▶ System instructions", entry.text);
    } else {
      parts.push("▶ System", entry.text);
    }
    parts.push("");
  }
  return parts.join("\n").trimEnd();
}

function historyPageForConversation(
  convId: string,
  full: boolean,
  limit: number,
  offset: number,
): Record<string, unknown> {
  const snapshot = convStore.getRenderSnapshot(convId, full);
  if (!snapshot) throw new Error(`Conversation ${convId} not found`);
  const entries = [...snapshot.entries];
  if (snapshot.pendingAI) entries.push({ type: "ai", ...snapshot.pendingAI });

  const total = entries.length;
  const end = Math.max(0, total - offset);
  const start = Math.max(0, end - limit);
  const selected = entries.slice(start, end);
  const hasOlder = start > 0;
  const hasNewer = end < total;
  return {
    conversation_id: convId,
    total_entries: total,
    returned: selected.length,
    offset,
    limit,
    truncated: selected.length < total,
    has_older: hasOlder,
    has_newer: hasNewer,
    next_older_offset: hasOlder ? offset + selected.length : null,
    next_newer_offset: hasNewer ? Math.max(0, Math.min(offset, total) - limit) : null,
    history: formatHistoryEntries(selected, full) || "(empty conversation)",
  };
}

function normalizeFolderPath(input: string | undefined): string {
  const trimmed = (input ?? "/").trim();
  if (!trimmed || trimmed === "/") return "/";
  return trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
}

function folderPath(folders: FolderSummary[], folderId: string | null | undefined): string {
  if (!folderId) return "/";
  const names: string[] = [];
  const seen = new Set<string>();
  let folder = folders.find(candidate => candidate.id === folderId);
  while (folder && !seen.has(folder.id)) {
    seen.add(folder.id);
    names.unshift(folder.name);
    folder = folder.parentId ? folders.find(candidate => candidate.id === folder?.parentId) : undefined;
  }
  return names.length ? names.join("/") : "/";
}

function sidebarState(): SidebarState {
  return convStore.listSidebarState();
}

function resolveFolderPath(state: SidebarState, input: string | undefined): FolderResolution | null {
  const normalized = normalizeFolderPath(input);
  if (normalized === "/") return { kind: "root", folderId: null, path: "/" };
  const folder = state.folders.find(candidate => folderPath(state.folders, candidate.id).toLowerCase() === normalized.toLowerCase());
  return folder
    ? { kind: "folder", folder, folderId: folder.id, path: folderPath(state.folders, folder.id) }
    : null;
}

function directFolders(state: SidebarState, parentId: string | null): FolderSummary[] {
  return state.folders
    .filter(folder => (folder.parentId ?? null) === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

function directConversations(state: SidebarState, parentId: string | null): SidebarState["conversations"] {
  return state.conversations
    .filter(conversation => (conversation.folderId ?? null) === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title));
}

function jobStatus(conversation: SidebarState["conversations"][number]): "running" | "done" | null {
  if (conversation.streaming) return "running";
  if (conversation.unread) return "done";
  return null;
}

function conversationStatus(conversation: SidebarState["conversations"][number]): "running" | "done" | "idle" {
  return jobStatus(conversation) ?? "idle";
}

function matchesConversationQuery(
  conversation: SidebarState["conversations"][number],
  query: string | undefined,
): boolean {
  if (!query) return true;
  const haystack = [
    conversation.id,
    conversation.title,
    conversation.provider,
    conversation.model,
  ].join("\n").toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function requestedScope(
  input: Record<string, unknown>,
  fallback: "children" | "all",
  parentConversationId: string | undefined,
): "children" | "all" {
  const value = input.scope ?? fallback;
  if (value !== "children" && value !== "all") throw new Error("scope must be children or all");
  if (value === "children" && !parentConversationId) {
    if (input.scope === "children") throw new Error("scope=children requires an active conversation context");
    return "all";
  }
  return value;
}

function compactConversation(conversation: SidebarState["conversations"][number]): Record<string, unknown> {
  return {
    id: conversation.id,
    title: conversation.title,
    provider: conversation.provider,
    model: conversation.model,
    message_count: conversation.messageCount,
    updated_at: conversation.updatedAt,
    status: conversationStatus(conversation),
    folder_id: conversation.folderId ?? null,
  };
}

function compactTask(task: ActiveConversationTask): Record<string, unknown> {
  const owner = convStore.getSummary(task.ownerConversationId);
  return {
    id: task.id,
    kind: task.kind,
    status: task.status,
    owner_conversation_id: task.ownerConversationId,
    owner_title: owner?.title ?? "",
    title: task.title,
    started_at: task.startedAt,
    ...(task.dueAt !== undefined ? { due_at: task.dueAt } : {}),
    ...(task.chronoMode ? { chrono_mode: task.chronoMode } : {}),
    ...(task.kind === "subagent" ? { child_conversation_id: task.id } : {}),
    ...(task.toolName ? { tool: task.toolName } : {}),
    ...(task.pid !== undefined ? { pid: task.pid } : {}),
    ...(task.backgroundedAt !== undefined ? { backgrounded_at: task.backgroundedAt } : {}),
    ...(task.cwd ? { cwd: task.cwd } : {}),
    ...(task.outputPath ? { output_path: task.outputPath } : {}),
  };
}

function childCount(state: SidebarState, parentId: string | null): number {
  return directFolders(state, parentId).length + directConversations(state, parentId).length;
}

function flattenTree(state: SidebarState, parentId: string | null, depth = 0): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const folder of directFolders(state, parentId)) {
    rows.push({ depth, type: "folder", id: folder.id, name: folder.name, path: folderPath(state.folders, folder.id), children: childCount(state, folder.id) });
    rows.push(...flattenTree(state, folder.id, depth + 1));
  }
  for (const conversation of directConversations(state, parentId)) {
    rows.push({ depth, type: "conversation", id: conversation.id, name: conversation.title || "(untitled)", path: folderPath(state.folders, conversation.folderId), status: conversationStatus(conversation) });
  }
  return rows;
}

function sidebarItemParent(state: SidebarState, item: SidebarItemRef): string | null | undefined {
  if (item.type === "conversation") return state.conversations.find(candidate => candidate.id === item.id)?.folderId ?? null;
  return state.folders.find(candidate => candidate.id === item.id)?.parentId ?? null;
}

function descendantFolderIds(state: SidebarState, folderId: string): Set<string> {
  const result = new Set<string>([folderId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of state.folders) {
      if (folder.parentId && result.has(folder.parentId) && !result.has(folder.id)) {
        result.add(folder.id);
        changed = true;
      }
    }
  }
  return result;
}

function resolveSidebarItem(state: SidebarState, value: string): SidebarItemRef {
  const conversation = state.conversations.find(candidate => candidate.id === value);
  if (conversation) return { type: "conversation", id: conversation.id };
  const folder = resolveFolderPath(state, value);
  if (folder?.kind === "folder") return { type: "folder", id: folder.folderId };
  throw new Error(`No conversation ID or folder path found for ${JSON.stringify(value)}`);
}

function resolveMoveDestination(state: SidebarState, items: SidebarItemRef[], value: string): FolderResolution {
  if (value.trim() === "..") {
    const parents = new Set(items.map(item => sidebarItemParent(state, item)));
    if (parents.has(undefined)) throw new Error("Cannot resolve parent for one or more source items");
    if (parents.size !== 1) throw new Error("'..' requires all source items to be in the same folder");
    const currentParent = [...parents][0] ?? null;
    if (!currentParent) return { kind: "root", folderId: null, path: "/" };
    const currentFolder = state.folders.find(folder => folder.id === currentParent);
    if (!currentFolder?.parentId) return { kind: "root", folderId: null, path: "/" };
    const parent = state.folders.find(folder => folder.id === currentFolder.parentId);
    return parent
      ? { kind: "folder", folder: parent, folderId: parent.id, path: folderPath(state.folders, parent.id) }
      : { kind: "root", folderId: null, path: "/" };
  }

  const destination = resolveFolderPath(state, value);
  if (!destination) throw new Error(`Folder not found: ${value}`);
  for (const item of items) {
    if (item.type === "folder" && destination.folderId && descendantFolderIds(state, item.id).has(destination.folderId)) {
      throw new Error("Cannot move a folder into itself or one of its descendants");
    }
  }
  return destination;
}

function uniqueItems(items: SidebarItemRef[]): SidebarItemRef[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = `${item.type}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function failedOutcome(error: unknown): AssistantTurnOutcome {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    blocks: [],
    tokens: 0,
    durationMs: 0,
    endedAt: Date.now(),
    error: `✗ ${message}`,
  };
}

export function createExocortexToolRuntime(deps: ExocortexToolRuntimeDependencies): ExocortexToolRuntime {
  const { server } = deps;

  const broadcastSidebar = () => server.broadcast({ type: "conversation_moved", ...convStore.listSidebarState() });

  const setTrackedSubagent = (
    parentConvId: string | undefined,
    childConvId: string,
    active: boolean,
    details?: { title: string; startedAt: number },
  ): void => {
    if (!parentConvId) return;
    if (setSubagentActive(parentConvId, childConvId, active, details)) {
      broadcastConversationUpdated(server, parentConvId);
    }
  };

  const ensureSubagentCapacity = (parentConvId: string | undefined): void => {
    if (parentConvId && getConversationActivityCounts(parentConvId).subagentCount >= MAX_ACTIVE_EXO_SUBAGENTS_PER_PARENT) {
      throw new Error(`Conversation ${parentConvId} already has ${MAX_ACTIVE_EXO_SUBAGENTS_PER_PARENT} active subagents; wait for one to finish or abort it.`);
    }
    if (getActiveSubagentCount() >= MAX_ACTIVE_EXO_SUBAGENTS_GLOBAL) {
      throw new Error(`The daemon already has ${MAX_ACTIVE_EXO_SUBAGENTS_GLOBAL} active native subagents; wait for one to finish or abort it.`);
    }
  };

  const ensureCanStart = (provider: ProviderId): void => {
    if (!(deps.hasCredentials ?? hasConfiguredCredentials)(provider)) {
      throw new Error(`Not authenticated for provider ${provider}`);
    }
    const blocked = deps.cannotStart?.(provider);
    if (blocked) throw new Error(blocked);
  };

  const setRequestedModel = (convId: string, input: Record<string, unknown>): void => {
    if (typeof input.model !== "string" || !input.model.trim()) return;
    const conv = convStore.get(convId);
    if (!conv) throw new Error(`Conversation ${convId} not found`);
    if (convStore.isStreaming(convId)) throw new Error("Cannot switch provider/model while the conversation is streaming.");
    const requested = parseRequestedModel(input.provider, input.model);
    const provider = requested.provider ?? conv.provider;
    const model = requested.model!;
    if (!getProvider(provider)) throw new Error(`Unknown provider: ${provider}`);
    if (!isKnownModel(provider, model) && !allowsCustomModels(provider)) throw new Error(unknownModelMessage(provider, model));
    ensureCanStart(provider);
    const effort = normalizeEffort(provider, model, conv.effort);
    const fastMode = supportsFastMode(provider) ? conv.fastMode : false;
    if (!convStore.setModel(convId, provider, model, effort, fastMode)) throw new Error(`Conversation ${convId} not found`);
    broadcastConversationUpdated(server, convId);
  };

  const executeSend = async (
    input: Record<string, unknown>,
    parentConvId: string | undefined,
    callerMaxDepth: number | null | undefined,
    signal?: AbortSignal,
  ): Promise<ToolResult> => {
    const text = stringInput(input, "text", true)!;
    const maxDepth = requestedMaxDepth(input, callerMaxDepth);
    let convId = stringInput(input, "conversation_id");
    const requestedTitle = convId ? undefined : subagentTitleInput(input);
    let taskTitle: string;
    let created = false;

    if (!convId) {
      ensureSubagentCapacity(parentConvId);
      const selection = resolveModelSelection(input);
      ensureCanStart(selection.provider);
      const folder = convStore.ensureTopLevelFolder(SUBAGENTS_FOLDER_NAME);
      if (!folder) throw new Error(`Failed to create ${SUBAGENTS_FOLDER_NAME} folder`);
      convId = convStore.generateId();
      convStore.create(convId, selection.provider, selection.model, requestedTitle, selection.effort, selection.fastMode, folder.id);
      taskTitle = requestedTitle!;
      created = true;
      broadcastConversationUpdated(server, convId);
      broadcastSidebar();
      log("info", `exo tool: created subagent ${convId} (${selection.provider}/${selection.model})`);
    } else {
      const target = convStore.get(convId);
      if (!target) throw new Error(`Conversation ${convId} not found`);
      taskTitle = target.title || "Subagent task";
      setRequestedModel(convId, input);
      ensureCanStart(convStore.get(convId)!.provider);
    }

    const modeValue = input.mode;
    const mode = modeValue === "detach" || modeValue === "wait" || modeValue === "auto" ? modeValue : "auto";

    // Sending to the currently executing conversation cannot recursively start a
    // second turn. Match exo-cli's useful behavior by queueing it for next turn.
    if (convId === parentConvId) {
      if (mode === "detach" || mode === "wait") {
        throw new Error("Cannot start a nested turn on the active parent conversation; use mode=auto or action=queue.");
      }
      convStore.pushQueuedMessage(convId, text, "next-turn", undefined, maxDepth);
      return ok(`Conversation ${convId} is active; queued the message for its next turn.`);
    }

    if (convStore.isStreaming(convId)) {
      if (mode === "wait") {
        convStore.pushQueuedMessage(convId, text, "next-turn", undefined, maxDepth);
        return ok(`Conversation ${convId} is busy; queued the message for its next turn.`);
      }
      throw new Error(`Conversation ${convId} is already streaming`);
    }
    if (!created) ensureSubagentCapacity(parentConvId);
    const shouldDetach = mode !== "wait";
    const startedAt = Date.now();

    if (shouldDetach) {
      const notify = booleanInput(input, "notify_parent", true) && Boolean(parentConvId);
      if (notify && parentConvId) {
        deps.beginParentNotification?.({ convId: parentConvId }, convId, text, startedAt, maxDepth);
      }
      setTrackedSubagent(parentConvId, convId, true, { title: taskTitle, startedAt });
      void deps.runTurn(convId, text, maxDepth, startedAt).then(outcome => {
        setTrackedSubagent(parentConvId, convId!, false);
        if (notify && parentConvId) {
          if (deps.completeParentNotification) deps.completeParentNotification(convId!, outcome);
          else deps.notifyParent?.(parentConvId, convId!, text, outcome);
        }
      }).catch(error => {
        setTrackedSubagent(parentConvId, convId!, false);
        log("error", `exo tool: detached subagent ${convId} failed: ${error instanceof Error ? error.message : error}`);
        if (notify && parentConvId) {
          const outcome = failedOutcome(error);
          if (deps.completeParentNotification) deps.completeParentNotification(convId!, outcome);
          else deps.notifyParent?.(parentConvId, convId!, text, outcome);
        }
      });
      return ok(pretty({ conversation_id: convId, title: taskTitle, status: "running", detached: true, created, max_depth: maxDepth, notify_parent: notify ? parentConvId : null }));
    }

    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const onAbort = () => convStore.getActiveJob(convId!)?.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    setTrackedSubagent(parentConvId, convId, true, { title: taskTitle, startedAt });
    try {
      const outcome = await deps.runTurn(convId, text, maxDepth, startedAt);
      const full = booleanInput(input, "full", false);
      const body = outcome.ok
        ? formatBlocks(outcome.blocks, full) || "(subagent completed without text output)"
        : outcome.error || "Subagent failed";
      return {
        output: `${body}\n\nexo:${convId}`,
        isError: !outcome.ok,
      };
    } finally {
      setTrackedSubagent(parentConvId, convId, false);
      signal?.removeEventListener("abort", onAbort);
    }
  };

  const executeList = (input: Record<string, unknown>, parentConvId: string | undefined): ToolResult => {
    const scope = requestedScope(input, "all", parentConvId);
    const query = stringInput(input, "query");
    const limit = boundedIntegerInput(input, "limit", DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
    const offset = boundedIntegerInput(input, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
    const childIds = scope === "children" && parentConvId
      ? new Set(getSubagentConversationIds(parentConvId))
      : null;
    const matches = convStore.listSummaries()
      .filter(conversation => !childIds || childIds.has(conversation.id))
      .filter(conversation => matchesConversationQuery(conversation, query))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    const conversations = matches.slice(offset, offset + limit).map(compactConversation);
    return ok(pretty({
      scope,
      parent_conversation_id: scope === "children" ? parentConvId : null,
      query: query ?? null,
      total: matches.length,
      returned: conversations.length,
      offset,
      limit,
      truncated: offset > 0 || offset + conversations.length < matches.length,
      next_offset: offset + conversations.length < matches.length ? offset + conversations.length : null,
      conversations,
    }));
  };

  const executeJobs = (input: Record<string, unknown>, parentConvId: string | undefined): ToolResult => {
    const scope = requestedScope(input, "children", parentConvId);
    const query = stringInput(input, "query");
    const limit = boundedIntegerInput(input, "limit", DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
    const offset = boundedIntegerInput(input, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
    const childIds = scope === "children" && parentConvId
      ? new Set(getSubagentConversationIds(parentConvId))
      : null;
    const matches = convStore.listSummaries()
      .filter(conversation => !childIds || childIds.has(conversation.id))
      .filter(conversation => matchesConversationQuery(conversation, query))
      .flatMap(conversation => {
        const status = jobStatus(conversation);
        return status ? [{
          id: conversation.id,
          title: conversation.title,
          status,
          running: status === "running",
          done: status === "done",
          updated_at: conversation.updatedAt,
        }] : [];
      })
      .sort((a, b) => b.updated_at - a.updated_at || a.id.localeCompare(b.id));
    const jobs = matches.slice(offset, offset + limit);
    return ok(pretty({
      scope,
      parent_conversation_id: scope === "children" ? parentConvId : null,
      query: query ?? null,
      total: matches.length,
      returned: jobs.length,
      offset,
      limit,
      truncated: offset > 0 || offset + jobs.length < matches.length,
      next_offset: offset + jobs.length < matches.length ? offset + jobs.length : null,
      jobs,
    }));
  };

  const executeTasks = (input: Record<string, unknown>, parentConvId: string | undefined): ToolResult => {
    const scopeValue = input.scope ?? "children";
    if (scopeValue !== "children" && scopeValue !== "all") throw new Error("scope must be children or all");
    const scope: "children" | "all" = scopeValue;
    const requestedConversationId = stringInput(input, "conversation_id");
    if (scope === "all" && requestedConversationId) {
      throw new Error("conversation_id cannot be combined with scope=all for action=tasks");
    }
    const ownerConversationId = requestedConversationId ?? parentConvId;
    if (scope === "children" && !ownerConversationId) {
      throw new Error("action=tasks requires an active conversation, conversation_id, or scope=all");
    }
    if (ownerConversationId && !convStore.getSummary(ownerConversationId)) {
      throw new Error(`Conversation ${ownerConversationId} not found`);
    }

    const kind = input.kind ?? "all";
    if (kind !== "all" && kind !== "subagent" && kind !== "background" && kind !== "chrono") {
      throw new Error("kind must be all, subagent, background, or chrono");
    }
    const query = stringInput(input, "query");
    const queryLower = query?.toLowerCase();
    const limit = boundedIntegerInput(input, "limit", DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
    const offset = boundedIntegerInput(input, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
    const matches = listActiveConversationTasks(scope === "all" ? undefined : ownerConversationId)
      .filter(task => kind === "all" || task.kind === kind)
      .filter(task => {
        if (!queryLower) return true;
        const owner = convStore.getSummary(task.ownerConversationId);
        return [task.id, task.kind, task.title, task.toolName, task.ownerConversationId, owner?.title]
          .filter(Boolean)
          .join("\n")
          .toLowerCase()
          .includes(queryLower);
      })
      .sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id));
    const tasks = matches.slice(offset, offset + limit).map(compactTask);
    return ok(pretty({
      scope: scope === "all" ? "all" : "conversation",
      owner_conversation_id: scope === "all" ? null : ownerConversationId,
      kind,
      query: query ?? null,
      total: matches.length,
      returned: tasks.length,
      offset,
      limit,
      truncated: offset > 0 || offset + tasks.length < matches.length,
      next_offset: offset + tasks.length < matches.length ? offset + tasks.length : null,
      tasks,
    }));
  };

  const executeInfo = (input: Record<string, unknown>): ToolResult => {
    const convId = stringInput(input, "conversation_id", true)!;
    const summary = convStore.getSummary(convId);
    const snapshot = convStore.getRenderSnapshot(convId, false);
    if (!summary || !snapshot) throw new Error(`Conversation ${convId} not found`);
    const result = ok(pretty({
      conversation_id: convId,
      title: summary.title,
      provider: summary.provider,
      model: summary.model,
      effort: summary.effort,
      fast_mode: summary.fastMode,
      context_tokens: snapshot.contextTokens,
      message_count: snapshot.entries.length,
      pinned: summary.pinned,
      marked: summary.marked,
      streaming: summary.streaming,
      unread: summary.unread,
      created_at: summary.createdAt,
      updated_at: summary.updatedAt,
      folder_id: summary.folderId ?? null,
      subagent_max_depth: convStore.get(convId)?.subagentMaxDepth ?? null,
      queued_messages: convStore.getQueuedMessages(convId).map(message => ({
        text: message.text,
        timing: message.timing,
        max_depth: message.subagentMaxDepth ?? null,
        image_count: message.images?.length ?? 0,
      })),
    }));
    if (convStore.clearUnread(convId)) broadcastConversationUpdated(server, convId);
    return result;
  };

  const executeHistory = (input: Record<string, unknown>): ToolResult => {
    const convId = stringInput(input, "conversation_id", true)!;
    const limit = boundedIntegerInput(input, "limit", DEFAULT_HISTORY_LIMIT, 1, MAX_HISTORY_LIMIT);
    const offset = boundedIntegerInput(input, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
    const result = ok(pretty(historyPageForConversation(convId, booleanInput(input, "full", false), limit, offset)));
    if (convStore.clearUnread(convId)) broadcastConversationUpdated(server, convId);
    return result;
  };

  const waitForStreamsToStop = async (convIds: string[], signal?: AbortSignal): Promise<void> => {
    const running = convIds.filter(convId => convStore.isStreaming(convId));
    for (const convId of running) convStore.getActiveJob(convId)?.abort();
    const deadline = Date.now() + 5_000;
    while (running.some(convId => convStore.isStreaming(convId)) && Date.now() < deadline) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const remaining = running.filter(convId => convStore.isStreaming(convId));
    if (remaining.length) throw new Error(`Timed out waiting for conversations to stop: ${remaining.join(", ")}`);
  };

  const executeDelete = async (input: Record<string, unknown>, parentConvId: string | undefined, signal?: AbortSignal): Promise<ToolResult> => {
    const convId = stringInput(input, "conversation_id", true)!;
    if (convId === parentConvId) throw new Error("Cannot delete the conversation currently executing this tool.");
    if (!convStore.getSummary(convId)) throw new Error(`Conversation ${convId} not found`);
    await waitForStreamsToStop([convId], signal);
    if (!convStore.remove(convId)) throw new Error(`Conversation ${convId} not found`);
    server.broadcast({ type: "conversation_deleted", convId });
    return ok(`Deleted ${convId}`);
  };

  const executeAbort = (input: Record<string, unknown>): ToolResult => {
    const convId = stringInput(input, "conversation_id", true)!;
    if (!convStore.getSummary(convId)) throw new Error(`Conversation ${convId} not found`);
    const controller = convStore.getActiveJob(convId);
    if (!controller) return ok(`Conversation ${convId} has no active job.`);
    controller.abort();
    return ok(`Aborted ${convId}.`);
  };

  const executeQueue = (input: Record<string, unknown>, callerMaxDepth: number | null | undefined): ToolResult => {
    const convId = stringInput(input, "conversation_id", true)!;
    const text = stringInput(input, "text", true)!;
    const maxDepth = requestedMaxDepth(input, callerMaxDepth);
    if (!convStore.getSummary(convId)) throw new Error(`Conversation ${convId} not found`);
    const timing: QueueTiming = input.timing === "message-end" ? "message-end" : "next-turn";
    convStore.pushQueuedMessage(convId, text, timing, undefined, maxDepth);
    return ok(`Queued (${timing}, max_depth=${maxDepth}) for ${convId}`);
  };

  const executeRename = (input: Record<string, unknown>, parentConvId: string | undefined): ToolResult => {
    const convId = conversationIdInput(input, parentConvId);
    const title = stringInput(input, "title", true)!;
    if (!convStore.rename(convId, title)) throw new Error(`Conversation ${convId} not found`);
    broadcastConversationUpdated(server, convId);
    return ok(`Renamed ${convId} to ${JSON.stringify(title)}`);
  };

  const executeLlm = async (input: Record<string, unknown>, parentConvId: string | undefined, signal?: AbortSignal): Promise<ToolResult> => {
    const text = stringInput(input, "text", true)!;
    const system = typeof input.system === "string" ? input.system : "";
    const selection = resolveModelSelection(input);
    ensureCanStart(selection.provider);
    const maxTokens = Math.min(128_000, Math.max(1, numberInput(input, "max_tokens", 16_000)));
    const result = await (deps.runCompletion ?? complete)(system, text, {
      provider: selection.provider,
      model: selection.model,
      maxTokens,
      effort: selection.effort,
      serviceTier: selection.fastMode ? "fast" : undefined,
      signal,
      tracking: { source: "llm_complete", ...(parentConvId ? { conversationId: parentConvId } : {}) },
    });
    server.broadcast({ type: "token_stats", stats: getTokenStatsSnapshot() });
    return ok(result.text);
  };

  const executeStatus = (): ToolResult => {
    const conversations = convStore.listSummaries();
    return ok(pretty({
      status: "ok",
      instance: "current",
      conversations: conversations.length,
      streaming: conversations.filter(conversation => conversation.streaming).length,
    }));
  };

  const executeFolderList = (input: Record<string, unknown>): ToolResult => {
    const state = sidebarState();
    const requestedPath = stringInput(input, "path") ?? "/";
    const target = resolveFolderPath(state, requestedPath);
    if (!target) throw new Error(`Folder not found: ${requestedPath}`);
    return ok(pretty({
      path: target.path,
      folder_id: target.folderId,
      folders: directFolders(state, target.folderId).map(folder => ({ id: folder.id, name: folder.name, path: folderPath(state.folders, folder.id), children: childCount(state, folder.id) })),
      conversations: directConversations(state, target.folderId).map(conversation => ({ id: conversation.id, title: conversation.title, status: conversationStatus(conversation), streaming: conversation.streaming, completed: conversation.unread && !conversation.streaming })),
    }));
  };

  const executeFolderTree = (input: Record<string, unknown>): ToolResult => {
    const state = sidebarState();
    const requestedPath = stringInput(input, "path") ?? "/";
    const target = resolveFolderPath(state, requestedPath);
    if (!target) throw new Error(`Folder not found: ${requestedPath}`);
    return ok(pretty({ path: target.path, folder_id: target.folderId, entries: flattenTree(state, target.folderId) }));
  };

  const executeFolderMkdir = (input: Record<string, unknown>): ToolResult => {
    const normalized = normalizeFolderPath(stringInput(input, "path", true));
    if (normalized === "/") throw new Error("Cannot create root folder");
    const created: Array<{ id: string; name: string; path: string; parent_id: string | null }> = [];
    let state = sidebarState();
    let parentId: string | null = null;
    let currentPath = "";
    for (const part of normalized.split("/").filter(Boolean)) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const existing = state.folders.find(folder => (folder.parentId ?? null) === parentId && folder.name.toLowerCase() === part.toLowerCase());
      if (existing) {
        parentId = existing.id;
        continue;
      }
      const folder = convStore.createFolder(part, parentId, []);
      if (!folder) throw new Error(`Could not create folder: ${currentPath}`);
      created.push({ id: folder.id, name: folder.name, path: currentPath, parent_id: parentId });
      parentId = folder.id;
      state = sidebarState();
    }
    if (created.length) broadcastSidebar();
    return ok(pretty({ path: normalized, created }));
  };

  const executeFolderMove = (input: Record<string, unknown>): ToolResult => {
    const rawSources = input.sources;
    if (!Array.isArray(rawSources) || rawSources.length === 0 || rawSources.some(source => typeof source !== "string" || !source.trim())) {
      throw new Error("sources must contain at least one conversation ID or folder path for action=folder_mv");
    }
    const destinationValue = stringInput(input, "destination", true)!;
    const state = sidebarState();
    const items = uniqueItems(rawSources.map(source => resolveSidebarItem(state, (source as string).trim())));
    const destination = resolveMoveDestination(state, items, destinationValue);
    if (!convStore.moveSidebarItems(items, destination.folderId)) {
      const alreadyThere = items.every(item => sidebarItemParent(state, item) === destination.folderId);
      if (!alreadyThere) throw new Error("Could not move one or more sidebar items");
    }
    broadcastSidebar();
    return ok(pretty({ items, folder_id: destination.folderId, folder: destination.path }));
  };

  const executeFolderRemove = async (input: Record<string, unknown>, parentConvId: string | undefined, signal?: AbortSignal): Promise<ToolResult> => {
    const requestedPath = stringInput(input, "path", true)!;
    const state = sidebarState();
    const target = resolveFolderPath(state, requestedPath);
    if (!target || target.kind !== "folder") throw new Error(`Folder not found: ${requestedPath}`);
    const mode = input.mode === "unwrap" ? "unwrap" : "recursive";
    if (mode === "unwrap") {
      if (!convStore.deleteFolder(target.folderId, "unwrap")) throw new Error(`Folder not found: ${requestedPath}`);
      broadcastSidebar();
      return ok(pretty({ removed: target.path, folder_id: target.folderId, mode }));
    }
    const deletedConvIds = convStore.listFolderConversationIds(target.folderId);
    if (parentConvId && deletedConvIds.includes(parentConvId)) {
      throw new Error("Cannot recursively remove a folder containing the conversation currently executing this tool.");
    }
    await waitForStreamsToStop(deletedConvIds, signal);
    if (!convStore.deleteFolder(target.folderId, "recursive")) throw new Error(`Folder not found: ${requestedPath}`);
    for (const convId of deletedConvIds) server.broadcast({ type: "conversation_deleted", convId });
    broadcastSidebar();
    return ok(pretty({ removed: target.path, folder_id: target.folderId, mode, deleted_conversations: deletedConvIds }));
  };

  const executeFolderRename = (input: Record<string, unknown>): ToolResult => {
    const requestedPath = stringInput(input, "path", true)!;
    const name = stringInput(input, "name", true)!;
    const state = sidebarState();
    const target = resolveFolderPath(state, requestedPath);
    if (!target || target.kind !== "folder") throw new Error(`Folder not found: ${requestedPath}`);
    if (!convStore.renameFolder(target.folderId, name)) throw new Error(`Could not rename folder: ${requestedPath}`);
    broadcastSidebar();
    return ok(pretty({ folder_id: target.folderId, previous_path: target.path, name }));
  };

  const executeFolderPin = (input: Record<string, unknown>): ToolResult => {
    const requestedPath = stringInput(input, "path", true)!;
    const pinned = booleanInput(input, "pinned", true);
    const state = sidebarState();
    const target = resolveFolderPath(state, requestedPath);
    if (!target || target.kind !== "folder") throw new Error(`Folder not found: ${requestedPath}`);
    if (!convStore.pinFolder(target.folderId, pinned)) throw new Error(`Could not ${pinned ? "pin" : "unpin"} folder: ${requestedPath}`);
    broadcastSidebar();
    return ok(pretty({ folder_id: target.folderId, path: target.path, pinned }));
  };

  const executeMarkCommand = (args: Record<string, unknown>, parentConversationId: string | undefined): ToolResult => {
    const convId = conversationIdInput(args, parentConversationId);
    const marked = typeof args.marked === "boolean"
      ? args.marked
      : typeof args.starred === "boolean"
        ? args.starred
        : true;
    if (!convStore.mark(convId, marked)) throw new Error(`Conversation ${convId} not found`);
    broadcastConversationUpdated(server, convId);
    return ok(pretty({ conversation_id: convId, marked }));
  };

  const executePinCommand = (args: Record<string, unknown>, parentConversationId: string | undefined): ToolResult => {
    const convId = conversationIdInput(args, parentConversationId);
    const pinned = booleanInput(args, "pinned", true);
    if (!convStore.pin(convId, pinned)) throw new Error(`Conversation ${convId} not found`);
    broadcastSidebar();
    return ok(pretty({ conversation_id: convId, pinned }));
  };

  const executeReorderCommand = (args: Record<string, unknown>, parentConversationId: string | undefined): ToolResult => {
    const target = stringInput(args, "target") ?? parentConversationId;
    if (!target) throw new Error("target is required when there is no active conversation context");
    const direction = args.direction;
    if (direction !== "up" && direction !== "down") throw new Error("direction must be up or down");
    const steps = Math.min(100, Math.max(1, numberInput(args, "steps", 1)));
    const state = sidebarState();
    const item = resolveSidebarItem(state, target);
    let moved = 0;
    for (; moved < steps; moved++) {
      if (!convStore.moveSidebarItem(item, direction)) break;
    }
    if (moved === 0) throw new Error(`Could not move ${target} ${direction}; it may already be at that boundary or in a different pin section`);
    broadcastSidebar();
    return ok(pretty({ item, direction, steps_moved: moved }));
  };

  const executeCloneCommand = (args: Record<string, unknown>, parentConversationId: string | undefined): ToolResult => {
    const convId = conversationIdInput(args, parentConversationId);
    const cloned = convStore.clone(convId);
    if (!cloned) throw new Error(`Conversation ${convId} not found`);
    const summary = convStore.getSummary(cloned.id);
    if (!summary) throw new Error(`Conversation ${convId} was cloned but its summary is unavailable`);
    server.broadcast({ type: "conversation_restored", summary });
    broadcastSidebar();
    return ok(pretty({ source_conversation_id: convId, conversation_id: cloned.id, title: cloned.title }));
  };

  const executeSystemPromptCommand = (args: Record<string, unknown>, parentConversationId: string | undefined): ToolResult => {
    const convId = conversationIdInput(args, parentConversationId);
    const conversation = convStore.get(convId);
    if (!conversation) throw new Error(`Conversation ${convId} not found`);
    const instructions = convStore.getEffectiveSystemInstructions(convId);
    return ok(buildSystemPrompt({
      conversationInstructions: instructions ?? undefined,
      conversationId: convId,
    }));
  };

  const executeInstructionsCommand = (args: Record<string, unknown>, parentConversationId: string | undefined): ToolResult => {
    const allowedKeys = new Set(["operation", "scope", "conversation_id", "folder_id", "text", "expected_revision"]);
    const unknownKeys = Object.keys(args).filter(key => !allowedKeys.has(key));
    if (unknownKeys.length > 0) throw new Error(`Unknown instruction argument${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}`);

    const operation = stringInput(args, "operation", true)!.toLowerCase();
    if (operation !== "get" && operation !== "set" && operation !== "clear") {
      throw new Error("operation must be get, set, or clear");
    }
    const scope = stringInput(args, "scope", true)!.toLowerCase();
    if (scope !== "conversation" && scope !== "folder" && scope !== "app") {
      throw new Error("scope must be conversation, folder, or app");
    }
    if (operation === "get" && (args.text !== undefined || args.expected_revision !== undefined)) {
      throw new Error("text and expected_revision are not accepted for operation=get");
    }
    if (operation === "set" && args.text === undefined) throw new Error("text is required for operation=set");
    if (operation === "clear" && args.text !== undefined) throw new Error("text is not accepted for operation=clear");

    let currentText: string;
    let effectiveInstructions: string | null = null;
    let affectedConversationIds: string[];
    let target: Record<string, unknown>;

    if (scope === "conversation") {
      if (args.folder_id !== undefined) throw new Error("folder_id is only accepted for scope=folder");
      const convId = conversationIdInput(args, parentConversationId);
      if (!convStore.get(convId)) throw new Error(`Conversation ${convId} not found`);
      currentText = convStore.getSystemInstructions(convId) ?? "";
      effectiveInstructions = convStore.getEffectiveSystemInstructions(convId);
      affectedConversationIds = [convId];
      target = { conversation_id: convId };
    } else if (scope === "folder") {
      if (args.conversation_id !== undefined) throw new Error("conversation_id is only accepted for scope=conversation");
      const folderId = stringInput(args, "folder_id", true)!;
      const folder = convStore.listSidebarState().folders.find(candidate => candidate.id === folderId);
      const folderText = convStore.getFolderInstructions(folderId);
      if (!folder || folderText === null) throw new Error(`Folder ${folderId} not found`);
      currentText = folderText;
      effectiveInstructions = convStore.getEffectiveFolderInstructions(folderId);
      affectedConversationIds = convStore.listFolderConversationIds(folderId);
      target = { folder_id: folderId, name: folder.name };
    } else {
      if (args.conversation_id !== undefined || args.folder_id !== undefined) {
        throw new Error("conversation_id and folder_id are not accepted for scope=app");
      }
      currentText = reloadUserAddendum();
      affectedConversationIds = convStore.listSummaries().map(conversation => conversation.id);
      target = { app: true };
    }

    const currentRevision = instructionRevision(currentText);
    if (operation === "get") {
      return ok(pretty({
        scope,
        target,
        text: currentText,
        revision: currentRevision,
        ...(effectiveInstructions !== null ? { effective_instructions: effectiveInstructions } : {}),
        affected_conversations: affectedConversationIds.length,
        active_streams: affectedConversationIds.filter(convId => convStore.isStreaming(convId)).length,
      }));
    }

    const expectedRevision = stringInput(args, "expected_revision", true)!;
    if (expectedRevision !== currentRevision) {
      throw new Error(`Instructions changed since they were read (expected ${expectedRevision}, current ${currentRevision})`);
    }
    const nextText = operation === "clear" ? "" : stringInput(args, "text", true)!;
    const changed = nextText !== currentText;

    if (changed && scope === "conversation") {
      const convId = target.conversation_id as string;
      if (!convStore.setSystemInstructions(convId, nextText)) throw new Error(`Conversation ${convId} not found`);
      broadcastConversationInstructionsUpdated(server, convId, nextText);
      effectiveInstructions = convStore.getEffectiveSystemInstructions(convId);
    } else if (changed && scope === "folder") {
      const folderId = target.folder_id as string;
      if (!convStore.setFolderInstructions(folderId, nextText)) throw new Error(`Folder ${folderId} not found`);
      broadcastFolderInstructionsUpdated(server, folderId, nextText);
      effectiveInstructions = convStore.getEffectiveFolderInstructions(folderId);
    } else if (changed) {
      setUserAddendum(nextText);
    }

    return ok(pretty({
      scope,
      target,
      changed,
      text: nextText,
      previous_revision: currentRevision,
      revision: instructionRevision(nextText),
      ...(effectiveInstructions !== null ? { effective_instructions: effectiveInstructions } : {}),
      affected_conversations: affectedConversationIds.length,
      active_streams: affectedConversationIds.filter(convId => convStore.isStreaming(convId)).length,
      applies_from: "next_turn",
    }));
  };

  const executeStatsCommand = (args: Record<string, unknown>, parentConversationId: string | undefined): ToolResult => {
    const requestedProvider = providerInput(args.provider);
    if (requestedProvider && !getProvider(requestedProvider)) throw new Error(`Unknown provider: ${requestedProvider}`);
    const providers = requestedProvider ? [requestedProvider] : getProviders().map(provider => provider.id);
    const snapshot = getTokenStatsSnapshot();
    const includeDays = booleanInput(args, "include_days", false);
    const convId = stringInput(args, "conversation_id") ?? parentConversationId;
    const conversation = convId ? convStore.getSummary(convId) : null;
    const render = convId ? convStore.getRenderSnapshot(convId, false) : null;
    return ok(pretty({
      usage_by_provider: Object.fromEntries(providers.map(provider => [provider, getLastUsage(provider)])),
      token_stats: {
        updated_at: snapshot.updatedAt,
        today: snapshot.today,
        lifetime: snapshot.lifetime,
        ...(includeDays ? { days: snapshot.days } : {}),
      },
      conversation: conversation ? {
        id: conversation.id,
        provider: conversation.provider,
        model: conversation.model,
        context_tokens: render?.contextTokens ?? null,
        message_count: conversation.messageCount,
        streaming: conversation.streaming,
      } : null,
    }));
  };

  const executeTaskCommand = (args: Record<string, unknown>, parentConversationId: string | undefined): ToolResult => {
    const operation = stringInput(args, "operation", true)?.toLowerCase();
    const taskId = stringInput(args, "task_id", true)!;
    const task = listActiveConversationTasks().find(candidate => candidate.id === taskId);
    if (!task) throw new Error(`Active task ${taskId} not found`);
    if (operation === "info") return ok(pretty(compactTask(task)));
    if (operation !== "stop") throw new Error("operation must be info or stop");
    if (task.kind === "subagent") throw new Error(`Task ${taskId} is a subagent; abort conversation ${task.id} instead.`);
    if (task.kind === "chrono") throw new Error(`Task ${taskId} is managed by Chrono; use the chrono tool to list/cancel schedules, or abort its conversation for an active wait/sleep.`);

    const stopped = stopBackgroundTask(taskId, task.ownerConversationId === parentConversationId);
    if (stopped.result === "not-found") throw new Error(`Active task ${taskId} not found`);
    if (stopped.result === "not-stoppable") throw new Error(`Task ${taskId} cannot be stopped by the daemon`);
    if (stopped.result === "failed") throw new Error(`Failed to signal task ${taskId}; it remains running and can be retried.`);
    broadcastConversationUpdated(server, task.ownerConversationId);
    return ok(pretty({
      task_id: taskId,
      owner_conversation_id: task.ownerConversationId,
      status: stopped.result === "already-stopping" ? "stopping" : stopped.result,
    }));
  };

  const executeFolderCommand = async (args: Record<string, unknown>, parentConversationId: string | undefined, signal?: AbortSignal): Promise<ToolResult> => {
    const operation = stringInput(args, "operation", true)?.toLowerCase();
    switch (operation) {
      case "ls":
      case "list": return executeFolderList(args);
      case "tree": return executeFolderTree(args);
      case "mkdir":
      case "create": return executeFolderMkdir(args);
      case "mv":
      case "move": return executeFolderMove(args);
      case "rm":
      case "remove":
      case "delete": return await executeFolderRemove(args, parentConversationId, signal);
      case "rename": return executeFolderRename(args);
      case "pin": return executeFolderPin(args);
      case "unpin": return executeFolderPin({ ...args, pinned: false });
      default: throw new Error(`Unknown folder operation: ${String(operation)}`);
    }
  };

  const commandSchema = (
    properties: Record<string, unknown>,
    required: string[] = [],
  ): Record<string, unknown> => ({
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  });

  const commands: ExoCommandDefinition[] = [
    {
      name: "folder",
      description: "List, inspect, create, move, remove, rename, pin, or unpin conversation folders.",
      inputSchema: commandSchema({
        operation: { type: "string", enum: ["ls", "tree", "mkdir", "move", "remove", "rename", "pin", "unpin"] },
        path: { type: "string", description: "Folder path; / is root for ls/tree." },
        sources: { type: "array", items: { type: "string" }, description: "For move: conversation IDs and/or folder paths." },
        destination: { type: "string", description: "For move: destination folder path, /, or .." },
        name: { type: "string", description: "For rename: new folder name." },
        pinned: { type: "boolean", description: "For pin: defaults true." },
        mode: { type: "string", enum: ["recursive", "unwrap"], description: "For remove: defaults recursive." },
      }, ["operation"]),
      examples: [
        { operation: "ls", path: "/" },
        { operation: "mkdir", path: "research/results" },
        { operation: "move", sources: ["<conversation-id>"], destination: "research/" },
      ],
      execute: executeFolderCommand,
    },
    {
      name: "mark",
      description: "Mark/star or unmark a conversation.",
      inputSchema: commandSchema({
        conversation_id: { type: "string", description: "Defaults to the active conversation." },
        marked: { type: "boolean", description: "Defaults true." },
        starred: { type: "boolean", description: "Alias for marked." },
      }),
      examples: [{ marked: true }, { conversation_id: "<conversation-id>", marked: false }],
      execute: executeMarkCommand,
    },
    {
      name: "pin",
      description: "Pin or unpin a conversation.",
      inputSchema: commandSchema({
        conversation_id: { type: "string", description: "Defaults to the active conversation." },
        pinned: { type: "boolean", description: "Defaults true." },
      }),
      examples: [{ pinned: true }, { conversation_id: "<conversation-id>", pinned: false }],
      execute: executePinCommand,
    },
    {
      name: "reorder",
      description: "Move a conversation or folder up/down within its current sidebar section.",
      inputSchema: commandSchema({
        target: { type: "string", description: "Conversation ID or folder path; defaults to active conversation." },
        direction: { type: "string", enum: ["up", "down"] },
        steps: { type: "integer", minimum: 1, maximum: 100, default: 1 },
      }, ["direction"]),
      examples: [{ direction: "up" }, { target: "research/results", direction: "down", steps: 2 }],
      execute: executeReorderCommand,
    },
    {
      name: "rename",
      description: "Rename a conversation.",
      inputSchema: commandSchema({
        conversation_id: { type: "string", description: "Defaults to the active conversation." },
        title: { type: "string", description: "New conversation title." },
      }, ["title"]),
      examples: [{ title: "New title" }, { conversation_id: "<conversation-id>", title: "New title" }],
      execute: (args, parentConversationId) => executeRename(args, parentConversationId),
    },
    {
      name: "delete",
      description: "Soft-delete a conversation to Exocortex trash.",
      inputSchema: commandSchema({
        conversation_id: { type: "string", description: "Conversation to delete; cannot be the active caller." },
      }, ["conversation_id"]),
      examples: [{ conversation_id: "<conversation-id>" }],
      execute: executeDelete,
    },
    {
      name: "llm",
      description: "Run a stateless one-shot LLM completion.",
      inputSchema: commandSchema({
        text: { type: "string", description: "User prompt." },
        system: { type: "string", description: "Optional system prompt." },
        provider: { type: "string", enum: ["openai", "deepseek"] },
        model: { type: "string", description: "Optional model or provider/model spec." },
        max_tokens: { type: "integer", minimum: 1, maximum: 128000, default: 16000 },
      }, ["text"]),
      examples: [{ text: "Summarize this", system: "Be terse" }],
      execute: executeLlm,
    },
    {
      name: "clone",
      description: "Clone a persisted conversation and its history.",
      inputSchema: commandSchema({
        conversation_id: { type: "string", description: "Defaults to the active conversation." },
      }),
      examples: [{ conversation_id: "<conversation-id>" }],
      execute: executeCloneCommand,
    },
    {
      name: "system_prompt",
      description: "View the fully assembled system prompt for a conversation, including effective folder and conversation instructions.",
      inputSchema: commandSchema({
        conversation_id: { type: "string", description: "Defaults to the active conversation." },
      }),
      examples: [{}],
      execute: executeSystemPromptCommand,
    },
    {
      name: "instructions",
      description: "View or change persistent instructions. Only use when the user explicitly asks.",
      inputSchema: commandSchema({
        operation: { type: "string", enum: ["get", "set", "clear"] },
        scope: { type: "string", enum: ["conversation", "folder", "app"] },
        conversation_id: { type: "string", description: "Conversation target. Defaults to the current conversation." },
        folder_id: { type: "string", description: "Folder target." },
        text: { type: "string", description: "Replacement text for set." },
        expected_revision: { type: "string", description: "Revision returned by get. Required for set or clear." },
      }, ["operation", "scope"]),
      examples: [
        { operation: "get", scope: "conversation" },
        { operation: "set", scope: "folder", folder_id: "<folder-id>", text: "Folder instructions", expected_revision: "sha256:<revision>" },
      ],
      execute: executeInstructionsCommand,
    },
    {
      name: "stats",
      description: "Query detailed token accounting, cached provider usage windows, and current conversation context usage.",
      inputSchema: commandSchema({
        provider: { type: "string", enum: ["openai", "deepseek"] },
        conversation_id: { type: "string", description: "Defaults to the active conversation." },
        include_days: { type: "boolean", default: false },
      }),
      examples: [{ include_days: false }, { provider: "openai", include_days: true }],
      execute: executeStatsCommand,
    },
    {
      name: "task",
      description: "Inspect or stop one exact active managed task without accepting raw operating-system PIDs.",
      inputSchema: commandSchema({
        operation: { type: "string", enum: ["info", "stop"] },
        task_id: { type: "string", description: "Stable task id returned by action=tasks." },
      }, ["operation", "task_id"]),
      examples: [
        { operation: "info", task_id: "bash:<pid>:<nonce>" },
        { operation: "stop", task_id: "bash:<pid>:<nonce>" },
      ],
      execute: executeTaskCommand,
    },
    {
      name: "status",
      description: "Inspect current-daemon health and aggregate conversation activity.",
      inputSchema: commandSchema({}),
      examples: [{}],
      execute: () => executeStatus(),
    },
  ];
  const commandMap = new Map(commands.map(command => [command.name, command]));

  const commandHelp = (command: ExoCommandDefinition): string => pretty({
    command: command.name,
    description: command.description,
    input_schema: command.inputSchema,
    examples: command.examples ?? [],
  });

  const executeCommands = async (input: Record<string, unknown>, parentConversationId: string | undefined, signal?: AbortSignal): Promise<ToolResult> => {
    const commandName = (stringInput(input, "command") ?? "ls").toLowerCase();
    const args = objectInput(input, "args");
    if (commandName === "ls" || commandName === "list") {
      return ok(pretty({
        commands: commands.map(command => ({ name: command.name, description: command.description })),
        help: "Call action=commands, command=help, args={command: <name>} for argument details.",
      }));
    }
    if (commandName === "help") {
      const target = stringInput(args, "command", true)!.toLowerCase();
      const command = commandMap.get(target);
      if (!command) throw new Error(`Unknown exo command: ${target}. Run action=commands with command=ls.`);
      return ok(commandHelp(command));
    }

    const command = commandMap.get(commandName);
    if (!command) throw new Error(`Unknown exo command: ${commandName}. Run action=commands with command=ls.`);
    try {
      return await command.execute(args, parentConversationId, signal);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      const message = error instanceof Error ? error.message : String(error);
      return fail(`${message}\n\nCommand help:\n${commandHelp(command)}`);
    }
  };

  const runtime: ExocortexToolRuntime = {
    async execute(input, parentConversationId, signal, callerMaxDepth) {
      try {
        const action = input.action;
        if (typeof action !== "string" || !VALID_ACTIONS.has(action)) {
          throw new Error(`Invalid exo action: ${String(action)}`);
        }

        switch (action as RuntimeExoAction) {
          case "send": return await executeSend(input, parentConversationId, callerMaxDepth, signal);
          case "list": return executeList(input, parentConversationId);
          case "jobs": return executeJobs(input, parentConversationId);
          case "tasks": return executeTasks(input, parentConversationId);
          case "info": return executeInfo(input);
          case "history": return executeHistory(input);
          case "delete": return await executeDelete(input, parentConversationId, signal);
          case "abort": return executeAbort(input);
          case "queue": return executeQueue(input, callerMaxDepth);
          case "rename": return executeRename(input, parentConversationId);
          case "status": return executeStatus();
          case "commands": return await executeCommands(input, parentConversationId, signal);
          // Undocumented compatibility aliases for conversations that learned
          // the pre-registry schema before these operations moved under commands.
          case "llm": return await executeLlm(input, parentConversationId, signal);
          case "folder_ls": return executeFolderList(input);
          case "folder_tree": return executeFolderTree(input);
          case "folder_mkdir": return executeFolderMkdir(input);
          case "folder_mv": return executeFolderMove(input);
          case "folder_rm": return await executeFolderRemove(input, parentConversationId, signal);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
  runtimeByServer.set(server, runtime);
  return runtime;
}
