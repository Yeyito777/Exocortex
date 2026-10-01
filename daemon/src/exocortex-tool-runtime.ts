/** Native delegation only. Administration uses the daemon's JSON-lines IPC. */
import { latestSizeModel } from "./delegation-models";
import { hasConfiguredCredentials } from "./auth";
import { cancelDeferredChronoSleep } from "./chrono-service";
import * as convStore from "./conversations";
import {
  getActiveSubagentCount, getConversationActivityCounts, setSubagentActive,
} from "./conversation-activity";
import { broadcastConversationHistoryUpdated, broadcastConversationUpdated } from "./conversation-events";
import { log } from "./log";
import {
  MAX_ACTIVE_EXO_SUBAGENTS_GLOBAL, MAX_ACTIVE_EXO_SUBAGENTS_PER_PARENT, SUBAGENTS_FOLDER_NAME,
  type ProviderId,
} from "./messages";
import type { UserMessageAutomation } from "@exocortex/shared/protocol";
import type { AssistantTurnOutcome } from "./orchestrator";
import { getProvider, normalizeEffort, supportsFastMode } from "./providers/registry";
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
}

function result(value: unknown, isError = false): ToolResult {
  return { output: JSON.stringify(value, null, 2), isError };
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
        if (spawning === (input.abort !== undefined)) throw new Error("Specify exactly one of subagent or abort.");
        if (!spawning && input.args !== undefined) throw new Error("args is only available with subagent.");
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const parent = parentId ? convStore.get(parentId) : undefined;

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
            if (cancelDeferredChronoSleep(convId)) broadcastConversationHistoryUpdated(server, convId);
            server.sendToSubscribers(convId, { type: "goal_updated", convId, goal: convStore.getIndexedSummary(convId)?.goal ?? null });
            broadcastConversationUpdated(server, convId);
          }
          controller?.abort();
          return result({ conversation_id: convId, status: controller ? "aborted" : pausing ? "paused" : "idle" });
        }

        if (!parentId || !parent) throw new Error("subagent requires an active parent conversation.");
        if (callerMaxDepth === 0 || parent.subagentPolicy) throw new Error("Subagents cannot delegate further.");
        const prompt = (input.subagent as string).trim();
        if (!prompt) throw new Error("subagent requires a non-empty prompt.");
        const args = (input.args ?? {}) as { detach?: boolean; model?: "sol fast" | "astra" };
        const size = args.model === "astra" ? "astra" : "sol";
        const model = latestSizeModel(size, getProvider("openai")?.models.map(model => model.id) ?? []);
        if (!model) throw new Error(`Model ${size} is unavailable.`);
        const fastMode = size === "sol";
        if (fastMode && !supportsFastMode("openai", model)) throw new Error("Sol fast is unavailable.");
        if (!(deps.hasCredentials ?? hasConfiguredCredentials)("openai")) throw new Error("Not authenticated for provider openai");
        const blocked = deps.cannotStart?.("openai");
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
        const child = convStore.create(convId, "openai", model, title, normalizeEffort("openai", model, undefined), fastMode, folder.id);
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
        return result({ conversation_id: convId, status: "running", model: args.model ?? "sol fast", notify_parent: notify });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        return result({ error: error instanceof Error ? error.message : String(error) }, true);
      }
    },
  };
  runtimeByServer.set(server, runtime);
  return runtime;
}
