/** Native delegation only. Administration uses the daemon's JSON-lines IPC. */
import { latestClaudeModel, latestSizeModel } from "./delegation-models";
import { hasConfiguredCredentials } from "./auth";
import { listDeferredChronoSleeps } from "./chrono-service";
import { cancelSuspendedTurn } from "./suspended-turns";
import { listPendingSubagentNotifications } from "./subagent-notifications";
import * as convStore from "./conversations";
import {
  getActiveSubagentCount, getConversationActivityCounts, setSubagentActive,
} from "./conversation-activity";
import { broadcastConversationUpdated } from "./conversation-events";
import { log } from "./log";
import { requestDaemonRestart, type RestartRequestOptions } from "./requested-restart";
import {
  MAX_ACTIVE_EXO_SUBAGENTS_GLOBAL, MAX_ACTIVE_EXO_SUBAGENTS_PER_PARENT, SUBAGENTS_FOLDER_NAME,
  type EffortLevel, type ProviderId,
} from "./messages";
import type { UserMessageAutomation } from "@exocortex/shared/protocol";
import type { AssistantTurnOutcome } from "./orchestrator";
import {
  getSupportedEfforts, getProvider, normalizeEffort, supportsEffort, supportsFastMode,
} from "./providers/registry";
import type { DaemonServer } from "./server";
import { validateCommandArgs } from "./tools/command-schema";
import { exo } from "./tools/exo";
import type { ExocortexToolRuntime, ToolResult } from "./tools/types";

const runtimeByServer = new WeakMap<DaemonServer, ExocortexToolRuntime>();
export function getExocortexToolRuntime(server: DaemonServer): ExocortexToolRuntime | undefined {
  return runtimeByServer.get(server);
}

export interface ExocortexToolRuntimeDependencies {
  server: DaemonServer;
  runTurn(convId: string, text: string, maxDepth: number | null, startedAt: number,
    automation: UserMessageAutomation): Promise<AssistantTurnOutcome>;
  beginParentNotification?(parent: { convId: string; maxChars?: number }, childConvId: string,
    task: string, childStartedAt: number, subagentMaxDepth: number | null, trackAsSubagent: boolean): unknown;
  completeParentNotification?(childConvId: string, outcome: AssistantTurnOutcome): void;
  notifyParent?(parentConvId: string, childConvId: string, task: string, outcome: AssistantTurnOutcome): void;
  cannotStart?(provider: ProviderId): string | null;
  hasCredentials?(provider: ProviderId): boolean;
  /** Overrides for the restart guards/scheduler (tests). */
  restart?: RestartRequestOptions;
}

function result(value: unknown, isError = false): ToolResult {
  return { output: JSON.stringify(value, null, 2), isError };
}

interface SubagentModel { provider: ProviderId; model: string; effort: EffortLevel; fastMode: boolean }

/**
 * Claude parents default to Opus at high effort, others to Sol fast. OpenAI
 * offers only sol fast and astra; Claude accepts a catalog family or exact id.
 */
export function resolveSubagentModel(parentProvider: ProviderId, requested?: string, effort?: EffortLevel): SubagentModel {
  const choice = (requested ?? (parentProvider === "anthropic" ? "opus" : "sol fast")).trim().toLowerCase();
  const catalog = (provider: ProviderId) => getProvider(provider)?.models.map(model => model.id) ?? [];
  let selection: Omit<SubagentModel, "effort">;
  if (choice === "sol fast" || choice === "astra") {
    const size = choice === "astra" ? "astra" : "sol";
    const model = latestSizeModel(size, catalog("openai"));
    if (!model) throw new Error(`Model ${size} is unavailable.`);
    const fastMode = size === "sol";
    if (fastMode && !supportsFastMode("openai", model)) throw new Error("Sol fast is unavailable.");
    selection = { provider: "openai", model, fastMode };
  } else {
    const claude = catalog("anthropic");
    const model = claude.find(id => id === choice) ?? latestClaudeModel(choice, claude);
    if (!model) {
      throw new Error(`Unknown subagent model "${requested}". Use sol fast, astra, opus, sonnet, or a Claude catalog id (${claude.join(", ") || "none available"}).`);
    }
    selection = { provider: "anthropic", model, fastMode: false };
  }
  if (effort !== undefined && !supportsEffort(selection.provider, selection.model, effort)) {
    const supported = getSupportedEfforts(selection.provider, selection.model).map(info => info.effort);
    throw new Error(`${selection.model} does not support effort ${effort}. Supported: ${supported.join(", ") || "none"}.`);
  }
  const fallback = selection.provider === "anthropic" ? "high" : undefined;
  return { ...selection, effort: normalizeEffort(selection.provider, selection.model, effort ?? fallback) };
}

export function createExocortexToolRuntime(deps: ExocortexToolRuntimeDependencies): ExocortexToolRuntime {
  const { server } = deps;
  const track = (parentId: string, childId: string, active: boolean, details?: { title: string; startedAt: number }) => {
    if (setSubagentActive(parentId, childId, active, details)) broadcastConversationUpdated(server, parentId);
  };
  const runtime: ExocortexToolRuntime = {
    async execute(input, parentId, signal, callerMaxDepth) {
      try {
        validateCommandArgs(exo.inputSchema, input, "exo");
        const spawning = input.subagent !== undefined;
        const actions = [input.subagent, input.message, input.status, input.abort, input.restart]
          .filter(value => value !== undefined).length;
        if (actions !== 1) throw new Error("Specify exactly one of subagent, message, status, abort, or restart.");
        if (!spawning && input.args !== undefined) throw new Error("args is only available with subagent.");
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const parent = parentId ? convStore.get(parentId) : undefined;

        if (input.restart !== undefined) {
          if (!parentId || !parent) throw new Error("restart requires an active conversation.");
          if (callerMaxDepth === 0 || parent.subagentPolicy) throw new Error("Subagents cannot restart the daemon; ask the parent conversation.");
          const request = requestDaemonRestart(parentId, input.restart as string, deps.restart);
          return result({
            status: "scheduled",
            token: request.token,
            reason: request.reason,
            runs: "after this turn ends",
            note: "Finish this turn normally and do not request another restart. Other active conversations will be interrupted and replayed; this one will not. You will receive a notice once the new daemon has started.",
          });
        }

        if (input.status !== undefined) {
          const convId = (input.status as string).trim();
          if (!convId) throw new Error("status requires an exact conversation ID.");
          const summary = convStore.getSummary(convId);
          if (!summary) throw new Error(`Conversation ${convId} not found`);
          const streamingSince = convStore.getStreamingStartedAt(convId);
          const iso = (ms: number | undefined) => ms === undefined ? undefined : new Date(ms).toISOString();
          return result({
            conversation_id: convId,
            title: summary.title,
            status: summary.providerWaiting ? "waiting_for_connection" : summary.streaming ? "streaming" : "idle",
            ...(summary.streaming && streamingSince !== undefined ? { streaming_since: iso(streamingSince) } : {}),
            ...(convStore.getActiveBackgroundableToolName(convId) ? { active_tool: convStore.getActiveBackgroundableToolName(convId) } : {}),
            last_activity: iso(summary.updatedAt),
            message_count: summary.messageCount,
            model: summary.model,
            ...(summary.goal ? { goal: summary.goal.status } : {}),
            queued_messages: convStore.getQueuedMessages(convId).length,
            running_tasks: summary.tasks?.length ?? 0,
          });
        }

        if (input.message !== undefined) {
          const message = input.message as { conversation: string; text: string; delivery?: "now" | "after_turn" };
          const convId = message.conversation.trim();
          const text = message.text.trim();
          if (!convId) throw new Error("message requires an exact conversation ID.");
          if (!text) throw new Error("message requires non-empty text.");
          if (!parentId || !parent) throw new Error("message requires an active conversation.");
          if (convId === parentId) throw new Error("Cannot message the conversation currently executing this tool.");
          const target = convStore.getPolicyMetadata(convId);
          if (!target) throw new Error(`Conversation ${convId} not found`);
          if (parent.subagentPolicy && target.subagentPolicy?.parentConversationId !== parentId) {
            throw new Error("Subagents can only message their own direct children.");
          }
          const delivery = message.delivery ?? "now";
          const automation: UserMessageAutomation = { kind: "exo_send", sourceId: parentId };
          if (convStore.isStreaming(convId)) {
            // The same durable queue as a prompt queued in the TUI or by `exo queue`.
            // A turn only sleeping or waiting in chrono takes it now either way.
            const timing = delivery === "after_turn" && convStore.getActiveBackgroundableToolName(convId) !== "chrono"
              ? "message-end" : "next-turn";
            const entry = convStore.pushQueuedMessage(convId, text, timing, undefined, undefined, undefined,
              undefined, undefined, automation);
            if (timing === "next-turn") convStore.steerActiveTurn(convId);
            return result({
              conversation_id: convId, status: "queued", queue_id: entry.id, target_status: "streaming",
              delivers: timing === "next-turn" ? "at the active turn's next tool boundary" : "as a new turn after the active one ends",
            });
          }
          // An idle conversation starts its turn now, as a subagent does, and
          // the reply is reported back to the caller when that turn ends.
          if (!(deps.hasCredentials ?? hasConfiguredCredentials)(target.provider)) throw new Error(`Not authenticated for provider ${target.provider}`);
          const blocked = deps.cannotStart?.(target.provider);
          if (blocked) throw new Error(blocked);
          const ownChild = target.subagentPolicy?.parentConversationId === parentId;
          const startedAt = Date.now();
          const maxDepth = target.subagentMaxDepth ?? null;
          // A child suspended in a deferred chrono sleep still owes this caller
          // its task's result. This turn ends the sleep and continues that task,
          // so its outcome settles the existing notification.
          const continuesSleepingTask = listDeferredChronoSleeps(convId).length > 0
            && listPendingSubagentNotifications({ childConvId: convId, state: "running" })
              .some(record => record.parentConvId === parentId);
          if (!continuesSleepingTask) deps.beginParentNotification?.({ convId: parentId }, convId, text, startedAt, maxDepth, ownChild);
          const title = convStore.getIndexedSummary(convId)?.title || "Subagent task";
          if (ownChild) track(parentId, convId, true, { title, startedAt });
          let finished = false;
          const finish = (outcome: AssistantTurnOutcome) => {
            if (outcome.suspended || finished) return;
            finished = true;
            if (ownChild) track(parentId, convId, false);
            if (deps.completeParentNotification) deps.completeParentNotification(convId, outcome);
            else deps.notifyParent?.(parentId, convId, text, outcome);
          };
          // Admission is synchronous, so no other turn can start in between.
          let turn: Promise<AssistantTurnOutcome>;
          try { turn = deps.runTurn(convId, text, maxDepth, startedAt, automation); }
          catch (error) { turn = Promise.reject(error); }
          void turn.then(finish).catch(error => {
            log("error", `exo message to ${convId} failed: ${error instanceof Error ? error.message : String(error)}`);
            finish({ ok: false, blocks: [], tokens: 0, durationMs: 0, endedAt: Date.now(),
              error: error instanceof Error ? error.message : String(error) });
          });
          return result({
            conversation_id: convId, status: "delivered", target_status: "idle",
            delivers: "started a new turn now; its reply is reported to you when it ends",
          });
        }

        if (!spawning) {
          const convId = (input.abort as string).trim();
          if (!convId) throw new Error("abort requires an exact conversation ID.");
          if (convId === parentId) throw new Error("Cannot abort the conversation currently executing this tool.");
          const target = convStore.getPolicyMetadata(convId);
          if (!target) throw new Error(`Conversation ${convId} not found`);
          if (parent?.subagentPolicy && target.subagentPolicy?.parentConversationId !== parentId) {
            throw new Error("Subagents can only abort their own direct children.");
          }
          const controller = convStore.getActiveJob(convId);
          if (!controller) convStore.clearStreamHandoff(convId);
          const pausing = convStore.getIndexedSummary(convId)?.goal?.status === "active";
          if (pausing) {
            convStore.updateGoalStatus(convId, "paused", { reason: "Interrupted. Resume explicitly to continue." });
            convStore.clearGoalContinuationAfterStream(convId);
            convStore.clearStreamHandoff(convId);
            server.sendToSubscribers(convId, { type: "goal_updated", convId, goal: convStore.getIndexedSummary(convId)?.goal ?? null });
            broadcastConversationUpdated(server, convId);
          }
          // A turn suspended in a long chrono sleep/wait has no job to abort.
          const endedSuspended = cancelSuspendedTurn(server, convId);
          controller?.abort();
          return result({ conversation_id: convId, status: controller || endedSuspended ? "aborted" : pausing ? "paused" : "idle" });
        }

        if (!parentId || !parent) throw new Error("subagent requires an active parent conversation.");
        if (callerMaxDepth === 0 || parent.subagentPolicy) throw new Error("Subagents cannot delegate further.");
        const prompt = (input.subagent as string).trim();
        if (!prompt) throw new Error("subagent requires a non-empty prompt.");
        const args = (input.args ?? {}) as { detach?: boolean; model?: string; effort?: EffortLevel };
        const { provider, model, effort, fastMode } = resolveSubagentModel(parent.provider, args.model, args.effort);
        if (!(deps.hasCredentials ?? hasConfiguredCredentials)(provider)) throw new Error(`Not authenticated for provider ${provider}`);
        const blocked = deps.cannotStart?.(provider);
        if (blocked) throw new Error(blocked);
        if (getConversationActivityCounts(parentId).subagentCount >= MAX_ACTIVE_EXO_SUBAGENTS_PER_PARENT) {
          throw new Error(`Already at the ${MAX_ACTIVE_EXO_SUBAGENTS_PER_PARENT}-subagent parent limit.`);
        }
        if (getActiveSubagentCount() >= MAX_ACTIVE_EXO_SUBAGENTS_GLOBAL) {
          throw new Error(`Already at the ${MAX_ACTIVE_EXO_SUBAGENTS_GLOBAL}-subagent daemon limit.`);
        }
        const folder = convStore.ensureTopLevelFolder(SUBAGENTS_FOLDER_NAME, { mutedOnCreate: true });
        if (!folder) throw new Error(`Failed to create ${SUBAGENTS_FOLDER_NAME} folder`);
        const convId = convStore.generateId();
        const title = prompt.replace(/\s+/g, " ").split(" ").slice(0, 6).join(" ").slice(0, 60);
        const child = convStore.create(convId, provider, model, title, effort, fastMode, folder.id);
        child.subagentMaxDepth = 0;
        convStore.setSubagentPolicy(convId, {
          parentConversationId: parentId,
          // Storage compatibility only; capabilities are no longer parent-selected.
          allowEdits: true,
          parentSystemInstructions: convStore.getEffectiveSystemInstructions(parentId) ?? "",
        });
        broadcastConversationUpdated(server, convId);
        server.broadcast({ type: "conversation_moved", ...convStore.listSidebarState() });
        const startedAt = Date.now();
        const notify = args.detach !== true;
        if (notify) deps.beginParentNotification?.({ convId: parentId }, convId, prompt, startedAt, 0, true);
        track(parentId, convId, true, { title, startedAt });
        let finished = false;
        const finish = (outcome: AssistantTurnOutcome) => {
          if (outcome.suspended || finished) return;
          finished = true;
          track(parentId, convId, false);
          if (notify) {
            if (deps.completeParentNotification) deps.completeParentNotification(convId, outcome);
            else deps.notifyParent?.(parentId, convId, prompt, outcome);
          }
        };
        // Promise wrapper also handles a synchronously throwing startup hook.
        void Promise.resolve().then(() => deps.runTurn(convId, prompt, 0, startedAt, {
          kind: "exo_send", sourceId: parentId,
        })).then(finish).catch(error => {
          log("error", `exo subagent ${convId} failed: ${error instanceof Error ? error.message : String(error)}`);
          finish({ ok: false, blocks: [], tokens: 0, durationMs: 0, endedAt: Date.now(),
            error: error instanceof Error ? error.message : String(error) });
        });
        return result({
          conversation_id: convId, status: "running", provider, model, effort,
          ...(fastMode ? { fast_mode: true } : {}), notify_parent: notify,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        return result({ error: error instanceof Error ? error.message : String(error) }, true);
      }
    },
  };
  runtimeByServer.set(server, runtime);
  return runtime;
}
