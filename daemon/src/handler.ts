/**
 * Command handler for exocortexd.
 *
 * Routes IPC commands to the appropriate action. Thin dispatcher —
 * orchestration lives in orchestrator.ts, conversation data
 * transformations live in conversations.ts, usage state lives
 * in usage.ts.
 */

import { log } from "./log";
import { effectiveConversationDefaults } from "@exocortex/shared/config";
import { refreshUsage, handleUsageHeaders, getLastUsage, clearUsage } from "./usage";
import { orchestrateGoalContinuation, orchestrateReplayConversation, orchestrateSendMessage, type AssistantTurnOutcome } from "./orchestrator";
import { complete } from "./llm";
import { buildSystemPrompt } from "./system";
import { getToolDisplayInfo } from "./tools/registry";
import { getExternalToolStyles, manageExternalToolDaemon } from "./external-tools";
import { EFFORT_LEVELS, SUBAGENTS_FOLDER_NAME } from "./messages";
import { getDefaultProvider, getDefaultModel, getProvider, getProviders, isKnownModel, allowsCustomModels, refreshProviders, normalizeEffort, supportsEffort, getSupportedEfforts, supportsFastMode, supportsImageInputs } from "./providers/registry";
import { transcribeAudioBytes } from "./transcription";
import { startTitleGeneration, isPendingTitle, PENDING_TITLE } from "./titlegen";
import * as convStore from "./conversations";
import { DaemonServer, type ConnectedClient } from "./server";
import type { Command } from "./protocol";
import { clearAuth, ensureAuthenticated, getAuthByProvider, getAuthInfoByProvider, hasConfiguredCredentials, invalidateCredentialsCache } from "./auth";
import { addAccount as addOpenAIAccount, listAccounts as listOpenAIAccounts, removeAccount as removeOpenAIAccount, switchAccount as switchOpenAIAccount } from "./providers/openai/auth";
import { getProviderAdapter } from "./providers/catalog";
import { getTokenStatsSnapshot } from "./token-stats";
import {
  broadcastConversationInstructionsUpdated,
  broadcastConversationUpdated,
  broadcastFolderInstructionsUpdated,
} from "./conversation-events";
import { applyUserGoalAction, setGoal as setConversationGoal } from "./goals";
import { createExocortexToolRuntime } from "./exocortex-tool-runtime";
import type { BackgroundTaskCompletion, ExocortexToolRuntime } from "./tools/types";
import { getSubagentParentConversationId, setSubagentActive } from "./conversation-activity";
import {
  acknowledgeSubagentNotification,
  beginPendingSubagentNotification,
  hasSubagentNotificationBeenDelivered,
  hasSubagentTaskStarted,
  listPendingSubagentNotifications,
  registerSubagentNotificationRuntime,
  settlePendingSubagentNotifications,
  type PendingSubagentNotification,
} from "./subagent-notifications";
import { beginDaemonShutdown, getDaemonShutdownMode } from "./daemon-lifecycle";
import { buildBackgroundTaskNotificationText } from "./background-task-notifications";
import { configureChronoService } from "./chrono-service";
import { INITIAL_HISTORY_TURNS, buildHistoryUpdatedEvents, compactHistoryImages, pageDisplayHistory } from "./history-pagination";

// ── Handler ─────────────────────────────────────────────────────────

let queueSchedulerGeneration = 0;

export function createHandler(server: DaemonServer) {
  // ── Local helper functions ────────────────────────────────────────

  let openAIAccountMutationInFlight = false;
  let exocortexRuntime: ExocortexToolRuntime | undefined;
  const pendingBackgroundNotifications = new Map<string, { convId: string; completion: BackgroundTaskCompletion }>();
  configureChronoService((convId) => broadcastConversationUpdated(server, convId));

  const broadcastUsage = (provider: import("./messages").ProviderId, usage: import("./messages").UsageData | null) => {
    server.broadcast({ type: "usage_update", provider, usage });
  };
  const broadcastTokenStats = () => {
    server.broadcast({ type: "token_stats", stats: getTokenStatsSnapshot() });
  };
  const describeAvailableModels = (provider: import("./messages").ProviderId): string => {
    const available = getProvider(provider)?.models.map((model) => model.id) ?? [];
    return available.length > 0 ? available.join(", ") : "none";
  };
  const unknownModelMessage = (provider: import("./messages").ProviderId, model: string): string => {
    return `Unknown model for provider ${provider}: ${model}. Available models: ${describeAvailableModels(provider)}`;
  };
  const inferProviderForModel = (model: string | undefined): import("./messages").ProviderId | undefined => {
    const lowered = model?.trim().toLowerCase();
    if (!lowered) return undefined;
    if (lowered === "pro" || lowered === "flash" || lowered.startsWith("deepseek-") || lowered.startsWith("v4-")) return "deepseek";
    if (lowered.startsWith("gpt-") || lowered.startsWith("o1") || lowered.startsWith("o3") || lowered.startsWith("o4")) return "openai";
    return undefined;
  };
  const modelDefaultForProvider = (provider: import("./messages").ProviderId): string => {
    const defaults = effectiveConversationDefaults();
    return provider === defaults.provider ? defaults.model : getDefaultModel(provider);
  };
  const effortDefaultForSelection = (provider: import("./messages").ProviderId, model: string): import("./messages").EffortLevel | undefined => {
    const defaults = effectiveConversationDefaults();
    return provider === defaults.provider && model === defaults.model ? defaults.effort : undefined;
  };
  const fastDefaultForSelection = (provider: import("./messages").ProviderId, model: string): boolean => {
    const defaults = effectiveConversationDefaults();
    return provider === defaults.provider && model === defaults.model && defaults.fastMode;
  };
  const formatOpenAIAccount = (account: ReturnType<typeof listOpenAIAccounts>[number]): string => {
    const marker = account.current ? "*" : " ";
    const label = account.email ?? account.displayName ?? account.accountId ?? `account-${account.index}`;
    const plan = account.plan ?? "unknown";
    return `${marker} ${account.index}. ${label} — ${plan}`;
  };
  const formatOpenAIAccountList = (): string => {
    const accounts = listOpenAIAccounts();
    if (accounts.length === 0) return "No OpenAI accounts are connected. Use /login openai to authenticate.";
    return [
      "OpenAI accounts:",
      ...accounts.map(formatOpenAIAccount),
      "",
      "* = current account",
    ].join("\n");
  };
  const hasStreamingOpenAIConversation = (): boolean => convStore.listSummaries()
    .some((conversation) => conversation.provider === "openai" && conversation.streaming);
  const rejectOpenAIAccountMutationWhileStreaming = (client: ConnectedClient, reqId?: string): boolean => {
    if (!hasStreamingOpenAIConversation()) return false;
    server.sendTo(client, {
      type: "error",
      reqId,
      message: "Cannot change OpenAI accounts while an OpenAI conversation is streaming.",
    });
    return true;
  };
  const rejectDuringOpenAIAccountMutation = (
    client: ConnectedClient,
    reqId: string | undefined,
    convId?: string,
  ): boolean => {
    if (!openAIAccountMutationInFlight) return false;
    server.sendTo(client, {
      type: "error",
      reqId,
      ...(convId ? { convId } : {}),
      message: "Cannot start or change an OpenAI conversation while account authentication is still in progress.",
    });
    return true;
  };
  // ── Outbound status/tool broadcasts ───────────────────────────────

  const broadcastToolsAvailable = () => {
    const externalStyles = getExternalToolStyles();
    server.broadcast({
      type: "tools_available",
      providers: getProviders(),
      tools: getToolDisplayInfo(),
      authByProvider: getAuthByProvider(),
      authInfoByProvider: getAuthInfoByProvider(),
      ...(externalStyles.length > 0 ? { externalToolStyles: externalStyles } : {}),
    });
  };
  const buildOrchestrationCallbacks = (convId: string) => ({
    onHeaders: (h: Headers) => {
      const provider = convStore.get(convId)?.provider ?? getDefaultProvider().id;
      if (provider === "openai") broadcastToolsAvailable();
      handleUsageHeaders(provider, h, (usage) => broadcastUsage(provider, usage));
    },
    onComplete: () => {
      const provider = convStore.get(convId)?.provider ?? getDefaultProvider().id;
      refreshUsage(provider, (usage) => broadcastUsage(provider, usage));
      broadcastTokenStats();
    },
    onBackgroundTaskComplete: (completion: BackgroundTaskCompletion) => {
      const id = `${convId}:${completion.taskId}:${completion.endedAt}`;
      pendingBackgroundNotifications.set(id, { convId, completion });
      deliverPendingBackgroundNotifications();
    },
    exocortex: exocortexRuntime,
  });

  const getRenderSnapshot = (convId: string) => convStore.getRenderSnapshot(convId, false);

  const shouldAutoGenerateTitle = (convId: string): boolean => {
    const title = convStore.get(convId)?.title.trim() ?? "";
    return title === "" || isPendingTitle(title);
  };

  const maybeStartAutoTitleGeneration = (convId: string): void => {
    if (shouldAutoGenerateTitle(convId)) startTitleGeneration(server, convId);
  };

  // ── Durable subagent parent notifications ────────────────────────

  let notificationRetryTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleNotificationRetry = (): void => {
    if (notificationRetryTimer) return;
    notificationRetryTimer = setTimeout(() => {
      notificationRetryTimer = null;
      deliverReadyParentNotifications();
      deliverPendingBackgroundNotifications();
    }, 1_000);
    notificationRetryTimer.unref?.();
  };

  function deliverPendingBackgroundNotifications(): void {
    for (const [id, pending] of pendingBackgroundNotifications) {
      const parent = convStore.get(pending.convId);
      if (!parent) {
        pendingBackgroundNotifications.delete(id);
        log("warn", `handler: dropping background task notification for missing conversation ${pending.convId}`);
        continue;
      }
      if (getDaemonShutdownMode()) {
        pendingBackgroundNotifications.delete(id);
        continue;
      }

      const text = buildBackgroundTaskNotificationText(pending.completion);
      if (convStore.isStreaming(pending.convId)) {
        convStore.pushQueuedMessage(
          pending.convId,
          text,
          "next-turn",
          undefined,
          parent.subagentMaxDepth ?? null,
        );
        pendingBackgroundNotifications.delete(id);
        log("info", `handler: queued background task completion notification ${pending.completion.taskId} for ${pending.convId}`);
        continue;
      }
      if (!hasConfiguredCredentials(parent.provider)
          || (openAIAccountMutationInFlight && parent.provider === "openai")) {
        scheduleNotificationRetry();
        continue;
      }

      pendingBackgroundNotifications.delete(id);
      log("info", `handler: sending background task completion notification ${pending.completion.taskId} to ${pending.convId}`);
      void orchestrateSendMessage(
        server,
        null,
        undefined,
        pending.convId,
        text,
        Date.now(),
        buildOrchestrationCallbacks(pending.convId),
        undefined,
        { subagentMaxDepth: parent.subagentMaxDepth ?? null },
      ).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log("error", `handler: background task notification send failed for ${pending.convId}: ${message}`);
      });
    }
  }

  const queueReadyParentNotification = (record: PendingSubagentNotification): void => {
    const alreadyQueued = convStore.getQueuedMessages(record.parentConvId)
      .some((message) => message.subagentNotificationId === record.id);
    if (alreadyQueued) return;
    convStore.pushQueuedMessage(
      record.parentConvId,
      record.text!,
      "next-turn",
      undefined,
      convStore.get(record.parentConvId)?.subagentMaxDepth ?? null,
      record.id,
    );
    log("info", `handler: queued durable subagent completion notification ${record.childConvId} -> parent ${record.parentConvId}`);
  };

  const deliverReadyParentNotifications = (childConvId?: string): void => {
    for (const record of listPendingSubagentNotifications({ childConvId, state: "ready" })) {
      if (hasSubagentNotificationBeenDelivered(record)) {
        acknowledgeSubagentNotification(record.id);
        continue;
      }
      if (record.parentConvId === record.childConvId) {
        log("warn", `handler: dropping self-notification for ${record.childConvId}`);
        acknowledgeSubagentNotification(record.id);
        continue;
      }
      const parent = convStore.get(record.parentConvId);
      if (!parent) {
        log("warn", `handler: parent conversation ${record.parentConvId} not found for subagent ${record.childConvId}; keeping notification pending`);
        continue;
      }
      if (convStore.isStreaming(record.parentConvId)) {
        queueReadyParentNotification(record);
        continue;
      }
      if (!hasConfiguredCredentials(parent.provider)) {
        log("info", `handler: deferring parent notification ${record.childConvId}; ${parent.provider} is not authenticated`);
        scheduleNotificationRetry();
        continue;
      }
      if (openAIAccountMutationInFlight && parent.provider === "openai") {
        log("info", `handler: deferring parent notification ${record.childConvId} while OpenAI account authentication is in progress`);
        scheduleNotificationRetry();
        continue;
      }

      log("info", `handler: sending durable subagent completion notification ${record.childConvId} -> parent ${record.parentConvId}`);
      void orchestrateSendMessage(
        server,
        null,
        undefined,
        record.parentConvId,
        record.text!,
        Date.now(),
        buildOrchestrationCallbacks(record.parentConvId),
        undefined,
        {
          subagentMaxDepth: parent.subagentMaxDepth ?? null,
          subagentNotificationId: record.id,
        },
      ).then(() => {
        // Preflight failures do not accept the user message and therefore leave
        // the durable record in place. Retry without duplicating accepted turns.
        if (listPendingSubagentNotifications().some((candidate) => candidate.id === record.id)) {
          scheduleNotificationRetry();
        }
      }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log("error", `handler: parent notification send failed for ${record.parentConvId}: ${msg}`);
        scheduleNotificationRetry();
      });
    }
  };

  const completeParentNotification = (childConvId: string, outcome: AssistantTurnOutcome): void => {
    const related = listPendingSubagentNotifications({ childConvId });
    settlePendingSubagentNotifications(childConvId, outcome);
    if (!(outcome.aborted && outcome.daemonRestart)) {
      const parentIds = new Set(related.map((record) => record.parentConvId));
      const knownParent = getSubagentParentConversationId(childConvId);
      if (knownParent) parentIds.add(knownParent);
      for (const parentConvId of parentIds) {
        if (setSubagentActive(parentConvId, childConvId, false)) {
          broadcastConversationUpdated(server, parentConvId);
        }
      }
    }
    deliverReadyParentNotifications(childConvId);
  };

  const notificationRuntime = {
    begin: beginPendingSubagentNotification,
    complete: completeParentNotification,
    deliverReady: deliverReadyParentNotifications,
  };
  registerSubagentNotificationRuntime(server, notificationRuntime);

  exocortexRuntime = createExocortexToolRuntime({
    server,
    runTurn: (convId, text, maxDepth, startedAt) => {
      const turn = orchestrateSendMessage(
        server,
        null,
        undefined,
        convId,
        text,
        startedAt,
        buildOrchestrationCallbacks(convId),
        undefined,
        { subagentMaxDepth: maxDepth },
      );
      maybeStartAutoTitleGeneration(convId);
      return turn;
    },
    beginParentNotification: notificationRuntime.begin,
    completeParentNotification: notificationRuntime.complete,
    cannotStart: (provider) => {
      const shutdownMode = getDaemonShutdownMode();
      if (shutdownMode) return `Cannot start a subagent while the daemon is shutting down (${shutdownMode}).`;
      return provider === "openai" && openAIAccountMutationInFlight
        ? "Cannot start or change an OpenAI conversation while account authentication is still in progress."
        : null;
    },
  });

  // ── Compact conversation payload helpers ─────────────────────────

  const sendCompactHistoryUpdated = (convId: string, resetHistoryWindow = false): boolean => {
    const data = getRenderSnapshot(convId);
    if (!data) return false;
    const events = buildHistoryUpdatedEvents(data, { resetHistoryWindow });
    const capabilitySender = (server as DaemonServer & {
      sendHistoryUpdatedToSubscribers?: DaemonServer["sendHistoryUpdatedToSubscribers"];
    }).sendHistoryUpdatedToSubscribers;
    if (capabilitySender) capabilitySender.call(server, convId, events.legacy, events.paginated);
    else server.sendToSubscribers(convId, events.legacy); // safe compatibility fallback for minimal test doubles
    return true;
  };

  const sendCompactConversationLoaded = (
    target: ConnectedClient,
    convId: string,
    reqId?: string,
    turns?: number,
  ) => {
    // Tool-result bodies are fetched separately only when the TUI expands them.
    const data = getRenderSnapshot(convId);
    if (!data) return null;
    const compactData = compactHistoryImages(data);
    const paginated = target.capabilities?.has("history-pagination") || turns !== undefined;
    const page = paginated ? pageDisplayHistory(compactData.entries, turns ?? INITIAL_HISTORY_TURNS) : null;
    const queued = convStore.getQueuedMessages(data.convId);
    const conv = convStore.get(data.convId);
    server.sendTo(target, {
      type: "conversation_loaded",
      reqId,
      convId: compactData.convId,
      provider: compactData.provider,
      model: compactData.model,
      effort: compactData.effort,
      fastMode: compactData.fastMode,
      entries: page ? [...page.pinnedEntries, ...page.entries] : compactData.entries,
      ...(page ? {
        historyStartIndex: page.startIndex,
        historyStartUserIndex: page.startUserIndex,
        historyTotalEntries: page.totalEntries,
        hasOlderHistory: page.hasOlder,
      } : {}),
      ...(compactData.pendingAI ? { pendingAI: compactData.pendingAI } : {}),
      contextTokens: compactData.contextTokens,
      toolOutputsIncluded: compactData.toolOutputsIncluded,
      queuedMessages: queued.length > 0 ? queued : undefined,
      goal: conv?.goal ?? null,
    });
    return data;
  };

  const sendCompactConversationHistory = (
    target: ConnectedClient,
    convId: string,
    beforeEntryIndex: number,
    turns: number,
    reqId?: string,
  ): boolean => {
    const data = getRenderSnapshot(convId);
    if (!data) return false;
    const compactData = compactHistoryImages(data);
    const page = pageDisplayHistory(compactData.entries, turns, beforeEntryIndex);
    server.sendTo(target, {
      type: "conversation_history_loaded",
      reqId,
      convId,
      entries: page.entries,
      historyStartIndex: page.startIndex,
      historyStartUserIndex: page.startUserIndex,
      historyEndIndex: page.endIndex,
      historyTotalEntries: page.totalEntries,
      hasOlderHistory: page.hasOlder,
    });
    return true;
  };

  const sendGoalUpdated = (convId: string, reqId: string | undefined, message?: string) => {
    const goal = convStore.get(convId)?.goal ?? null;
    server.sendToSubscribers(convId, { type: "goal_updated", reqId, convId, goal, message });
    broadcastConversationUpdated(server, convId);
    return goal;
  };

  const broadcastSidebarUndoResult = (
    target: ConnectedClient,
    reqId: string | undefined,
    result: convStore.UndoDeleteResult | null,
    emptyMessage: string,
  ): void => {
    if (result?.type === "conversation") {
      const summary = convStore.getSummary(result.conversation.id);
      if (summary) {
        server.broadcast({ type: "conversation_restored", reqId, summary });
        server.broadcast({ type: "conversation_moved", ...convStore.listSidebarState() });
        return;
      }
    } else if (result?.type === "conversations") {
      for (const conv of result.conversations) {
        const summary = convStore.getSummary(conv.id);
        if (summary) server.broadcast({ type: "conversation_restored", reqId, summary });
      }
      server.broadcast({ type: "conversation_moved", ...convStore.listSidebarState() });
      return;
    } else if (result?.type === "sidebar_state") {
      for (const convId of result.deletedConvIds ?? []) {
        server.broadcast({ type: "conversation_deleted", convId });
      }
      for (const convId of result.updatedConvIds ?? []) {
        broadcastConversationUpdated(server, convId);
      }
      for (const update of result.folderInstructions ?? []) {
        server.broadcast({ type: "folder_instructions_updated", reqId, folderId: update.folderId, text: update.text });
        for (const convId of convStore.listFolderConversationIds(update.folderId)) {
          sendCompactHistoryUpdated(convId);
        }
      }
      server.broadcast({ type: "conversation_moved", ...convStore.listSidebarState() });
      return;
    }

    server.sendTo(target, { type: "error", reqId, message: emptyMessage });
  };

  const isSafeClientConversationId = (id: string): boolean => /^\d+-[a-z0-9]{6}$/.test(id);

  // ── Daemon-owned queue scheduler ──────────────────────────────────

  let queuePumpTimer: ReturnType<typeof setTimeout> | null = null;
  const schedulerGeneration = ++queueSchedulerGeneration;
  const dispatchingQueueIds = new Set<string>();
  const dispatchingConversationIds = new Set<string>();
  /**
   * `/queue` is one global FIFO, so accepting/removing its head from durable
   * storage must not release the next entry while the accepted turn streams.
   * The per-entry dispatch set cannot provide that gate after removal because
   * the new head has a different id.
   */
  let globalIdleDispatchInFlight = false;
  const queueRetryAfter = new Map<string, number>();

  const scheduleQueuePump = (delayMs = 120): void => {
    if (schedulerGeneration !== queueSchedulerGeneration || getDaemonShutdownMode() || queuePumpTimer) return;
    queuePumpTimer = setTimeout(() => {
      queuePumpTimer = null;
      if (schedulerGeneration !== queueSchedulerGeneration) return;
      pumpQueuedMessages();
    }, delayMs);
  };

  const queueWaitStatus = (entry: import("./message-queue").QueuedMessage): "ready" | "waiting" | "missing-target" => {
    const waitTarget = entry.waitTarget ?? { type: "global" as const };
    const sidebar = convStore.listSidebarState();
    const hasStreamQueue = (convId: string) => convStore.isQueuedMessageDeliverySuspended(convId)
      || convStore.getQueuedMessages(convId).length > 0;

    if (waitTarget.type === "global") {
      if (sidebar.conversations.some(conversation => conversation.streaming)) return "waiting";
      if (convStore.listInternalQueuedMessages().some(message => message.source === "daemon")) return "waiting";
      return "ready";
    }
    if (waitTarget.type === "conversation") {
      const conversation = sidebar.conversations.find(candidate => candidate.id === waitTarget.convId);
      if (!conversation) return "missing-target";
      return conversation.streaming || hasStreamQueue(conversation.id) ? "waiting" : "ready";
    }

    const folderIds = new Set<string>([waitTarget.folderId]);
    if (!sidebar.folders.some(folder => folder.id === waitTarget.folderId)) return "missing-target";
    let changed = true;
    while (changed) {
      changed = false;
      for (const folder of sidebar.folders) {
        if (folder.parentId && folderIds.has(folder.parentId) && !folderIds.has(folder.id)) {
          folderIds.add(folder.id);
          changed = true;
        }
      }
    }
    return sidebar.conversations.some(conversation => conversation.folderId && folderIds.has(conversation.folderId)
      && (conversation.streaming || hasStreamQueue(conversation.id))) ? "waiting" : "ready";
  };

  const dispatchQueuedMessage = async (entry: import("./message-queue").QueuedMessage): Promise<void> => {
    if (dispatchingQueueIds.has(entry.id) || dispatchingConversationIds.has(entry.convId)) return;
    if (convStore.isQueuedMessageDeliverySuspended(entry.convId)) return;
    if ((queueRetryAfter.get(entry.id) ?? 0) > Date.now()) return;
    dispatchingQueueIds.add(entry.id);
    dispatchingConversationIds.add(entry.convId);
    if (entry.source === "global-idle") globalIdleDispatchInFlight = true;
    try {
      const outcome = await orchestrateSendMessage(
        server,
        null,
        undefined,
        entry.convId,
        entry.text,
        Date.now(),
        buildOrchestrationCallbacks(entry.convId),
        entry.images,
        {
          subagentMaxDepth: entry.subagentMaxDepth ?? null,
          subagentNotificationId: entry.subagentNotificationId,
          queueEntryId: entry.id,
        },
      );
      // Preflight failures happen before orchestrateSendMessage accepts/removes
      // the queue entry. Drop it with an explicit shared notice rather than
      // retrying forever and blocking FIFO progress.
      if (!outcome.ok && convStore.getQueuedMessageById(entry.id)) {
        const error = outcome.error ?? "unknown error";
        const retryable = error.includes("Not authenticated")
          || error.includes("Already streaming")
          || error.includes("shutting down")
          || error.includes("account authentication");
        if (retryable) {
          // Authentication/account mutation is recoverable user state. Keep the
          // durable queue entry and retry at a low cadence instead of dropping
          // accepted intent or hot-looping while no client is connected.
          queueRetryAfter.set(entry.id, Date.now() + 5_000);
          log("info", `handler: preserving queued message ${entry.id} after retryable preflight: ${error}`);
        } else {
          queueRetryAfter.delete(entry.id);
          convStore.removeQueuedMessageById(entry.id);
          server.broadcast({
            type: "queue_notice",
            queueId: entry.id,
            convId: entry.convId,
            message: `Queued send failed: ${error}`,
            level: "error",
          });
        }
      }
    } catch (err) {
      log("error", `handler: queued send failed for ${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
      if (convStore.getQueuedMessageById(entry.id)) queueRetryAfter.set(entry.id, Date.now() + 5_000);
    } finally {
      dispatchingQueueIds.delete(entry.id);
      dispatchingConversationIds.delete(entry.convId);
      if (entry.source === "global-idle") globalIdleDispatchInFlight = false;
      scheduleQueuePump();
    }
  };

  const pumpQueuedMessages = (): void => {
    if (getDaemonShutdownMode()) return;
    const queued = convStore.listInternalQueuedMessages();
    const queuedIds = new Set(queued.map(entry => entry.id));
    for (const id of queueRetryAfter.keys()) {
      if (!queuedIds.has(id)) queueRetryAfter.delete(id);
    }
    if (queued.length === 0) return;

    const now = Date.now();
    let needsReadinessPoll = false;
    let earliestRetryAt = Number.POSITIVE_INFINITY;
    const retryIsDeferred = (id: string): boolean => {
      const retryAt = queueRetryAfter.get(id) ?? 0;
      if (retryAt <= now) return false;
      earliestRetryAt = Math.min(earliestRetryAt, retryAt);
      return true;
    };

    // Ordinary per-conversation FIFO queues can make progress concurrently.
    const seenConversations = new Set<string>();
    for (const entry of queued) {
      if (entry.source !== "daemon" || seenConversations.has(entry.convId)) continue;
      seenConversations.add(entry.convId);
      if (!convStore.get(entry.convId)) {
        convStore.removeQueuedMessageById(entry.id);
        server.broadcast({ type: "queue_notice", queueId: entry.id, convId: entry.convId, message: "Dropped queued message because its conversation no longer exists.", level: "error" });
        continue;
      }
      if (!convStore.isStreaming(entry.convId) && !convStore.isQueuedMessageDeliverySuspended(entry.convId)) {
        if (!retryIsDeferred(entry.id)) void dispatchQueuedMessage(entry);
      } else {
        needsReadinessPoll = true;
      }
    }

    // `/queue` intentionally remains one global FIFO. Its first entry blocks
    // later idle-wait entries until its dependency is ready and its turn ends.
    const idleEntry = queued.find(entry => entry.source === "global-idle");
    if (idleEntry && !globalIdleDispatchInFlight && !dispatchingQueueIds.has(idleEntry.id)) {
      if (!convStore.get(idleEntry.convId) && idleEntry.target === "new-conversation") {
        const defaults = effectiveConversationDefaults();
        const provider = idleEntry.provider ?? defaults.provider;
        const providerInfo = getProvider(provider);
        if (providerInfo) {
          const model = idleEntry.model && (isKnownModel(provider, idleEntry.model) || allowsCustomModels(provider))
            ? idleEntry.model
            : (provider === defaults.provider ? defaults.model : getDefaultModel(provider));
          const effort = normalizeEffort(provider, model, idleEntry.effort);
          const fastMode = idleEntry.fastMode === true && supportsFastMode(provider);
          const folderId = idleEntry.folderId
            && convStore.listSidebarState().folders.some(folder => folder.id === idleEntry.folderId)
            ? idleEntry.folderId
            : null;
          convStore.create(idleEntry.convId, provider, model, PENDING_TITLE, effort, fastMode, folderId);
          broadcastConversationUpdated(server, idleEntry.convId);
          startTitleGeneration(server, idleEntry.convId, { extraContext: idleEntry.text });
          log("info", `handler: recovered queued draft conversation ${idleEntry.convId} from durable queue ${idleEntry.id}`);
        }
      }
      const status = queueWaitStatus(idleEntry);
      if (status === "missing-target" || !convStore.get(idleEntry.convId)) {
        convStore.removeQueuedMessageById(idleEntry.id);
        server.broadcast({
          type: "queue_notice",
          queueId: idleEntry.id,
          convId: idleEntry.convId,
          message: status === "missing-target"
            ? "Dropped queued message because its wait target no longer exists."
            : "Dropped queued message because its conversation no longer exists.",
          level: "error",
        });
      } else if (status === "ready"
          && !convStore.isStreaming(idleEntry.convId)
          && !convStore.isQueuedMessageDeliverySuspended(idleEntry.convId)) {
        if (!retryIsDeferred(idleEntry.id)) void dispatchQueuedMessage(idleEntry);
      } else {
        needsReadinessPoll = true;
      }
    }

    if (needsReadinessPoll) scheduleQueuePump();
    else if (Number.isFinite(earliestRetryAt)) scheduleQueuePump(Math.max(120, earliestRetryAt - Date.now()));
  };

  convStore.setQueuedMessagesChangedListener((messages) => {
    server.broadcast({ type: "queue_updated", messages });
    scheduleQueuePump();
  });

  return async function handleCommand(client: ConnectedClient, cmd: Command): Promise<void> {
    switch (cmd.type) {

      // ── Connection/bootstrap commands ──────────────────────────────

      case "ping": {
        server.sendTo(client, { type: "pong", reqId: cmd.reqId });
        const externalStyles = getExternalToolStyles();
        server.sendTo(client, {
          type: "tools_available",
          providers: getProviders(),
          tools: getToolDisplayInfo(),
          authByProvider: getAuthByProvider(),
          authInfoByProvider: getAuthInfoByProvider(),
          ...(externalStyles.length > 0 ? { externalToolStyles: externalStyles } : {}),
        });
        for (const provider of getProviders()) {
          const lastUsage = getLastUsage(provider.id);
          server.sendTo(client, { type: "usage_update", provider: provider.id, usage: lastUsage });
        }
        server.sendTo(client, { type: "token_stats", stats: getTokenStatsSnapshot() });
        server.sendTo(client, { type: "conversations_list", ...convStore.listSidebarState() });
        server.sendTo(client, { type: "queue_updated", messages: convStore.listQueuedMessages() });
        for (const provider of getProviders()) {
          if (!hasConfiguredCredentials(provider.id)) continue;
          refreshUsage(provider.id, (usage) => broadcastUsage(provider.id, usage));
        }
        void refreshProviders().then((changed) => {
          if (changed) broadcastToolsAvailable();
        }).catch((err) => {
          log("warn", `handler: provider refresh failed: ${err instanceof Error ? err.message : err}`);
        });
        break;
      }

      case "prepare_shutdown": {
        const mode = beginDaemonShutdown(cmd.mode);
        log("info", `handler: service requested daemon shutdown mode=${mode}`);
        server.sendTo(client, { type: "ack", reqId: cmd.reqId });
        break;
      }

      // ── Conversation lifecycle commands ───────────────────────────

      case "new_conversation": {
        const id = cmd.convId ?? convStore.generateId();
        if (cmd.convId && (!isSafeClientConversationId(cmd.convId) || convStore.get(cmd.convId))) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: "Invalid or duplicate client-supplied conversation id" });
          break;
        }
        const conversationDefaults = effectiveConversationDefaults();
        const provider = cmd.provider ?? inferProviderForModel(cmd.model) ?? conversationDefaults.provider;
        const providerInfo = getProvider(provider);
        if (!providerInfo) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: id, message: `Unknown provider: ${provider}` });
          break;
        }
        if (cmd.model && !isKnownModel(provider, cmd.model) && !allowsCustomModels(provider)) {
          server.sendTo(client, {
            type: "error",
            reqId: cmd.reqId,
            convId: id,
            message: unknownModelMessage(provider, cmd.model),
          });
          break;
        }
        const model = cmd.model ?? (provider === conversationDefaults.provider ? conversationDefaults.model : getDefaultModel(provider));
        const defaultEffort = provider === conversationDefaults.provider && model === conversationDefaults.model
          ? conversationDefaults.effort
          : undefined;
        const effort = normalizeEffort(provider, model, cmd.effort ?? defaultEffort);
        const requestedFastMode = typeof cmd.fastMode === "boolean"
          ? cmd.fastMode
          : (provider === conversationDefaults.provider && model === conversationDefaults.model ? conversationDefaults.fastMode : false);
        if (cmd.fastMode === true && !supportsFastMode(provider)) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: id, message: `Fast mode is only available for ${provider} conversations that support it.` });
          break;
        }
        const fastMode = requestedFastMode && supportsFastMode(provider);
        const initialMessage = cmd.initialMessage;
        const goalObjective = cmd.goalObjective?.trim();
        const titleContext = cmd.titleContext?.trim();
        if (provider === "openai" && (initialMessage || goalObjective)
            && rejectDuringOpenAIAccountMutation(client, cmd.reqId, id)) break;
        if (goalObjective && !hasConfiguredCredentials(provider)) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: id, message: `Not authenticated for provider ${provider}. Run: bun run src/main.ts login ${provider}` });
          break;
        }
        if (initialMessage) {
          if (!hasConfiguredCredentials(provider)) {
            server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: id, message: `Not authenticated for provider ${provider}. Run: bun run src/main.ts login ${provider}` });
            break;
          }
          if (initialMessage.images?.length && !supportsImageInputs(provider, model)) {
            server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: id, message: `Image inputs are not supported by ${provider}/${model}. Remove the attachment or switch to a vision-capable model.` });
            break;
          }
        }

        const title = cmd.title ?? (initialMessage || goalObjective || titleContext ? PENDING_TITLE : undefined);
        const subagentFolder = cmd.subagent ? convStore.ensureTopLevelFolder(SUBAGENTS_FOLDER_NAME) : null;
        if (cmd.subagent && !subagentFolder) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Failed to create ${SUBAGENTS_FOLDER_NAME} folder` });
          break;
        }
        const folderId = subagentFolder?.id ?? cmd.folderId ?? null;
        if (initialMessage) {
          convStore.createWithInitialUserMessage(id, provider, model, title, effort, fastMode, initialMessage, folderId);
        } else {
          convStore.create(id, provider, model, title, effort, fastMode, folderId);
        }
        const goalResult = goalObjective ? setConversationGoal(id, goalObjective, { pausable: cmd.goalPausable, completable: cmd.goalCompletable }) : null;
        const goal = goalResult?.goal ?? null;
        log("info", `handler: created conversation ${id} (provider=${provider}, model=${model}, fastMode=${fastMode}, title="${title ?? ""}", initialMessage=${Boolean(initialMessage)}, folderId=${folderId ?? "root"})`);

        server.sendTo(client, {
          type: "conversation_created",
          reqId: cmd.reqId,
          convId: id,
          provider,
          model,
          effort,
          fastMode,
          goal,
        });
        broadcastConversationUpdated(server, id);
        if (cmd.subagent) server.broadcast({ type: "conversation_moved", ...convStore.listSidebarState() });

        if (goalObjective && !initialMessage) {
          server.subscribe(client, id);
          server.sendToSubscribers(id, { type: "goal_updated", reqId: cmd.reqId, convId: id, goal, message: goalResult?.message ?? `Goal set: ${goalObjective}` });
          startTitleGeneration(server, id, { extraContext: goalObjective });
          void orchestrateGoalContinuation(server, id, buildOrchestrationCallbacks(id)).catch((err) => {
            log("error", `handler: initial new-conversation goal continuation failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
          });
        } else if (titleContext && !initialMessage) {
          startTitleGeneration(server, id, { extraContext: titleContext });
        }

        if (initialMessage) {
          // The creating client already has the local user echo and pending AI.
          // Subscribe it before starting the turn so it receives the stream as
          // soon as it processes the preceding conversation_created event.
          server.subscribe(client, id);
          const turn = orchestrateReplayConversation(
            server,
            client,
            cmd.reqId,
            id,
            initialMessage.startedAt,
            buildOrchestrationCallbacks(id),
            { subagentMaxDepth: null },
          );
          maybeStartAutoTitleGeneration(id);
          await turn;
        }
        break;
      }

      case "subscribe": {
        server.subscribe(client, cmd.convId);
        // Clear unread when a client views the conversation
        if (convStore.clearUnread(cmd.convId)) {
          broadcastConversationUpdated(server, cmd.convId);
        }
        server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
        break;
      }
      case "unsubscribe": {
        server.unsubscribe(client, cmd.convId);
        server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
        break;
      }

      case "abort": {
        const ac = convStore.getActiveJob(cmd.convId);
        if (ac) {
          ac.abort(cmd.reason === "daemon-restart" ? "daemon-restart" : undefined);
          log("info", `handler: abort requested for ${cmd.convId}${cmd.reason ? ` (${cmd.reason})` : ""}`);
        }
        server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
        break;
      }

      case "background_tool": {
        const result = convStore.backgroundActiveTool(cmd.convId);
        if (result === "none") {
          server.sendToSubscribers(cmd.convId, {
            type: "system_message",
            convId: cmd.convId,
            streamSeq: convStore.isStreaming(cmd.convId) ? convStore.nextStreamSeq(cmd.convId) : undefined,
            text: "No backgroundable tool call is currently running.",
            color: "warning",
          });
        }
        log("info", `handler: background_tool requested for ${cmd.convId}: ${result}`);
        server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
        break;
      }

      case "prewarm_conversation": {
        const conv = convStore.get(cmd.convId);
        if (!conv || conv.provider !== "openai" || convStore.isStreaming(cmd.convId)
            || openAIAccountMutationInFlight) break;
        void getProviderAdapter("openai").prewarmConversation?.(cmd.convId)
          .catch((err) => log("debug", `openai prewarm failed for ${cmd.convId}: ${err instanceof Error ? err.message : err}`));
        break;
      }

      case "set_goal": {
        const conv = convStore.get(cmd.convId);
        if (!conv) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
          break;
        }
        if (conv.provider === "openai" && (cmd.action === "set" || cmd.action === "resume")
            && rejectDuringOpenAIAccountMutation(client, cmd.reqId, cmd.convId)) break;

        if (cmd.action === "set") {
          const objective = cmd.objective?.trim();
          if (!objective) {
            server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: "Usage: /goal <objective>" });
            break;
          }
          if (convStore.isStreaming(cmd.convId)) {
            server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: "Cannot set a goal while the conversation is streaming." });
            break;
          }
          const result = setConversationGoal(cmd.convId, objective, { pausable: cmd.pausable, completable: cmd.completable });
          const goal = sendGoalUpdated(cmd.convId, cmd.reqId, result.message);
          log("info", `handler: set goal for ${cmd.convId}: "${objective.slice(0, 80)}"`);
          if (goal?.status === "active") {
            void orchestrateGoalContinuation(server, cmd.convId, buildOrchestrationCallbacks(cmd.convId), { subagentMaxDepth: null }).catch((err) => {
              log("error", `handler: initial goal continuation failed for ${cmd.convId}: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
          break;
        }

        if (cmd.action === "resume") {
          const result = applyUserGoalAction(conv, "resume");
          const goal = sendGoalUpdated(cmd.convId, cmd.reqId, result.message);
          if (goal?.status === "active" && !convStore.isStreaming(cmd.convId)) {
            void orchestrateGoalContinuation(server, cmd.convId, buildOrchestrationCallbacks(cmd.convId), { subagentMaxDepth: null }).catch((err) => {
              log("error", `handler: resumed goal continuation failed for ${cmd.convId}: ${err instanceof Error ? err.message : String(err)}`);
            });
          } else if (goal?.status === "active") {
            convStore.requestGoalContinuationAfterStream(cmd.convId);
            log("info", `handler: resumed goal for ${cmd.convId} while streaming; continuation will run after the active stream stops`);
          }
          break;
        }

        const result = applyUserGoalAction(conv, cmd.action);
        server.sendTo(client, { type: "goal_updated", reqId: cmd.reqId, convId: cmd.convId, goal: result.goal, message: result.message });
        if (cmd.action !== "show") broadcastConversationUpdated(server, cmd.convId);

        break;
      }

      case "manage_external_tool_daemon": {
        try {
          const status = await manageExternalToolDaemon(cmd.toolName, cmd.action);
          server.sendTo(client, { type: "external_tool_daemon_result", reqId: cmd.reqId, status });
          log("info", `handler: external tool daemon ${cmd.action} ${cmd.toolName} -> ${status.message}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message });
        }
        break;
      }

      // ── Assistant turn commands ───────────────────────────────────

      case "send_message": {
        const target = convStore.get(cmd.convId);
        if (target?.provider === "openai"
            && rejectDuringOpenAIAccountMutation(client, cmd.reqId, cmd.convId)) break;
        const callbacks = buildOrchestrationCallbacks(cmd.convId);
        if (cmd.detached) {
          if (cmd.notifyParent?.convId === cmd.convId) {
            server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: "Cannot notify the same conversation that is running the detached task." });
            break;
          }
          if (convStore.isStreaming(cmd.convId)) {
            server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: "Already streaming" });
            break;
          }
          const trackedParentId = cmd.notifyParent?.convId;
          if (cmd.notifyParent) {
            try {
              notificationRuntime.begin(cmd.notifyParent, cmd.convId, cmd.text, cmd.startedAt, null);
            } catch (err) {
              server.sendTo(client, {
                type: "error",
                reqId: cmd.reqId,
                convId: cmd.convId,
                message: err instanceof Error ? err.message : String(err),
              });
              break;
            }
          }
          if (trackedParentId && setSubagentActive(trackedParentId, cmd.convId, true, {
            title: target?.title || "Subagent task",
            startedAt: cmd.startedAt,
          })) {
            broadcastConversationUpdated(server, trackedParentId);
          }
          const finishTrackedSubagent = () => {
            if (trackedParentId && setSubagentActive(trackedParentId, cmd.convId, false)) {
              broadcastConversationUpdated(server, trackedParentId);
            }
          };
          server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
          const turn = orchestrateSendMessage(
            server, null, undefined, cmd.convId, cmd.text, cmd.startedAt, callbacks, cmd.images,
            { subagentMaxDepth: null },
          );
          maybeStartAutoTitleGeneration(cmd.convId);
          void turn.then((outcome) => {
            finishTrackedSubagent();
            if (cmd.notifyParent) notificationRuntime.complete(cmd.convId, outcome);
          }).catch((err) => {
            finishTrackedSubagent();
            const message = err instanceof Error ? err.message : String(err);
            log("error", `handler: detached send failed for ${cmd.convId}: ${message}`);
            if (cmd.notifyParent) {
              notificationRuntime.complete(cmd.convId, {
                ok: false,
                blocks: [],
                tokens: 0,
                durationMs: 0,
                endedAt: Date.now(),
                error: `✗ ${message}`,
              });
            }
          });
          break;
        }
        const outcome = orchestrateSendMessage(
          server, client, cmd.reqId, cmd.convId, cmd.text, cmd.startedAt,
          callbacks,
          cmd.images,
          { subagentMaxDepth: null },
        );
        maybeStartAutoTitleGeneration(cmd.convId);
        await outcome;
        break;
      }

      case "replay_conversation": {
        const target = convStore.get(cmd.convId);
        if (target?.provider === "openai"
            && rejectDuringOpenAIAccountMutation(client, cmd.reqId, cmd.convId)) break;
        const pending = listPendingSubagentNotifications({ childConvId: cmd.convId, state: "running" })[0];
        const outcome = pending && !hasSubagentTaskStarted(pending)
          ? await orchestrateSendMessage(
              server,
              client,
              cmd.reqId,
              cmd.convId,
              pending.task,
              pending.childStartedAt,
              buildOrchestrationCallbacks(cmd.convId),
              undefined,
              { subagentMaxDepth: pending.subagentMaxDepth },
            )
          : await orchestrateReplayConversation(
              server,
              client,
              cmd.reqId,
              cmd.convId,
              cmd.startedAt,
              buildOrchestrationCallbacks(cmd.convId),
              { subagentMaxDepth: pending?.subagentMaxDepth ?? null },
            );
        notificationRuntime.complete(cmd.convId, outcome);
        break;
      }

      // ── Conversation configuration/edit commands ──────────────────

      case "set_model": {
        const conv = convStore.get(cmd.convId);
        if (!conv) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
          break;
        }
        if (convStore.isStreaming(cmd.convId)) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: "Cannot switch provider/model while the conversation is streaming." });
          break;
        }
        const nextProvider = cmd.provider ?? inferProviderForModel(cmd.model) ?? conv.provider;
        if (!getProvider(nextProvider)) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Unknown provider: ${nextProvider}` });
          break;
        }
        if (!isKnownModel(nextProvider, cmd.model) && !allowsCustomModels(nextProvider)) {
          server.sendTo(client, {
            type: "error",
            reqId: cmd.reqId,
            convId: cmd.convId,
            message: unknownModelMessage(nextProvider, cmd.model),
          });
          break;
        }
        const nextEffort = normalizeEffort(nextProvider, cmd.model, conv.effort);
        const nextFastMode = supportsFastMode(nextProvider) ? conv.fastMode : false;
        // Keep the old checkpoint long enough for the orchestrator to detect an
        // incompatible replay. On the next turn it rebuilds from the canonical
        // transcript, sanitizes scoped provider data, and only compacts if the
        // destination window actually needs it. No hidden handler-side model
        // request exists outside the normal abort/restart lifecycle.
        const ok = convStore.setModel(cmd.convId, nextProvider, cmd.model, nextEffort, nextFastMode);
        if (ok) {
          server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
          broadcastConversationUpdated(server, cmd.convId);
          log("info", `handler: conversation ${cmd.convId} switched to ${nextProvider}/${cmd.model} (effort=${nextEffort}, fastMode=${nextFastMode})`);
        } else {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
        }
        break;
      }

      case "trim_conversation": {
        const conv = convStore.get(cmd.convId);
        if (!conv) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
          break;
        }
        if (convStore.isStreaming(cmd.convId)) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: "Cannot trim the conversation while it is streaming." });
          break;
        }
        const result = convStore.trimConversation(cmd.convId, cmd.mode, cmd.count);
        if (!result) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
          break;
        }
        server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
        if (result.changed) {
          sendCompactHistoryUpdated(cmd.convId, true);
          broadcastConversationUpdated(server, cmd.convId);
          server.sendToSubscribers(cmd.convId, { type: "system_message", convId: cmd.convId, text: result.message });
          log("info", `handler: trimmed ${cmd.mode} (${cmd.count}) for ${cmd.convId}`);
        } else {
          server.sendTo(client, { type: "system_message", convId: cmd.convId, text: result.message });
        }
        break;
      }

      case "set_effort": {
        if (!EFFORT_LEVELS.includes(cmd.effort)) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Invalid effort level: ${cmd.effort}. Valid: ${EFFORT_LEVELS.join(", ")}` });
          break;
        }
        const conv = convStore.get(cmd.convId);
        if (!conv) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
          break;
        }
        if (!supportsEffort(conv.provider, conv.model, cmd.effort)) {
          const valid = getSupportedEfforts(conv.provider, conv.model).map((candidate) => candidate.effort);
          server.sendTo(client, {
            type: "error",
            reqId: cmd.reqId,
            convId: cmd.convId,
            message: `Invalid effort for ${conv.provider}/${conv.model}: ${cmd.effort}. Valid: ${valid.join(", ")}`,
          });
          break;
        }
        const ok = convStore.setEffort(cmd.convId, cmd.effort);
        if (ok) {
          server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
          broadcastConversationUpdated(server, cmd.convId);
          log("info", `handler: effort set to ${cmd.effort} for ${cmd.convId}`);
        } else {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
        }
        break;
      }

      case "set_fast_mode": {
        const conv = convStore.get(cmd.convId);
        if (!conv) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
          break;
        }
        if (cmd.enabled && !supportsFastMode(conv.provider)) {
          server.sendTo(client, {
            type: "error",
            reqId: cmd.reqId,
            convId: cmd.convId,
            message: `Fast mode is only available for ${conv.provider} conversations that support it.`,
          });
          break;
        }
        const ok = convStore.setFastMode(cmd.convId, cmd.enabled);
        if (ok) {
          server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
          broadcastConversationUpdated(server, cmd.convId);
          log("info", `handler: fast mode ${cmd.enabled ? "enabled" : "disabled"} for ${cmd.convId}`);
        } else {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
        }
        break;
      }

      // ── Sidebar/list commands ─────────────────────────────────────

      case "list_conversations": {
        server.sendTo(client, { type: "conversations_list", reqId: cmd.reqId, ...convStore.listSidebarState() });
        server.sendTo(client, { type: "queue_updated", messages: convStore.listQueuedMessages() });
        break;
      }

      case "delete_conversation": {
        const ok = convStore.remove(cmd.convId);
        if (ok) {
          log("info", `handler: deleted conversation ${cmd.convId}`);
          server.broadcast({ type: "conversation_deleted", convId: cmd.convId });
        } else {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
        }
        break;
      }

      case "delete_conversations": {
        const deleted = convStore.removeMany(cmd.convIds);
        if (deleted.length > 0) {
          log("info", `handler: deleted ${deleted.length} conversations`);
          for (const convId of deleted) server.broadcast({ type: "conversation_deleted", convId });
        } else {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: "No conversations found to delete" });
        }
        break;
      }

      case "mark_conversation": {
        const ok = convStore.mark(cmd.convId, cmd.marked);
        if (ok) {
          server.broadcast({ type: "conversation_marked", convId: cmd.convId, marked: cmd.marked });
        }
        break;
      }

      case "pin_conversation": {
        const ok = convStore.pin(cmd.convId, cmd.pinned);
        if (ok) {
          // Single authoritative broadcast — carries the full list with
          // correct pinned flags and sortOrders.  A separate
          // conversation_pinned event is unnecessary and caused flicker
          // when the TUI re-sorted with stale sortOrder values.
          server.broadcast({ type: "conversation_moved", ...convStore.listSidebarState() });
        }
        break;
      }

      case "move_conversation": {
        const ok = convStore.move(cmd.convId, cmd.direction);
        if (ok) {
          server.broadcast({ type: "conversation_moved", ...convStore.listSidebarState() });
        }
        break;
      }

      case "rename_conversation": {
        const ok = convStore.rename(cmd.convId, cmd.title);
        if (ok) {
          server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
          broadcastConversationUpdated(server, cmd.convId);
          log("info", `handler: renamed conversation ${cmd.convId} to "${cmd.title}"`);
        } else {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
        }
        break;
      }

      case "generate_title": {
        if (!convStore.get(cmd.convId)) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
          break;
        }
        const started = startTitleGeneration(server, cmd.convId, { force: true });
        server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
        log("info", `handler: title generation ${started ? "started" : "skipped"} for ${cmd.convId}`);
        break;
      }

      case "clone_conversation": {
        const cloned = convStore.clone(cmd.convId);
        if (cloned) {
          const summary = convStore.getSummary(cloned.id);
          if (summary) {
            log("info", `handler: cloned conversation ${cmd.convId} → ${cloned.id}`);
            server.broadcast({ type: "conversation_restored", reqId: cmd.reqId, summary });
            server.broadcast({ type: "conversation_moved", ...convStore.listSidebarState() });
          }
        } else {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
        }
        break;
      }

      // ── Folder/sidebar organization commands ──────────────────────

      case "create_folder": {
        const folder = convStore.createFolder(cmd.name, cmd.parentId ?? null, cmd.items ?? []);
        if (folder) {
          server.sendTo(client, { type: "ack", reqId: cmd.reqId });
          server.broadcast({ type: "conversation_moved", ...convStore.listSidebarState() });
          log("info", `handler: created folder ${folder.id} (${folder.name})`);
        } else {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: "Folder name cannot be empty" });
        }
        break;
      }

      case "rename_folder": {
        const ok = convStore.renameFolder(cmd.folderId, cmd.name);
        if (ok) {
          server.sendTo(client, { type: "ack", reqId: cmd.reqId });
          server.broadcast({ type: "conversation_moved", ...convStore.listSidebarState() });
        } else {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Folder ${cmd.folderId} not found` });
        }
        break;
      }

      case "pin_folder": {
        if (convStore.pinFolder(cmd.folderId, cmd.pinned)) {
          server.broadcast({ type: "conversation_moved", ...convStore.listSidebarState() });
        }
        break;
      }

      case "pin_sidebar_items": {
        if (convStore.pinSidebarItems(cmd.pins)) {
          server.broadcast({ type: "conversation_moved", ...convStore.listSidebarState() });
        }
        break;
      }

      case "move_sidebar_item": {
        if (convStore.moveSidebarItem(cmd.item, cmd.direction)) {
          server.broadcast({ type: "conversation_moved", ...convStore.listSidebarState() });
        }
        break;
      }

      case "move_sidebar_items": {
        if (convStore.moveSidebarItems(cmd.items, cmd.parentId, cmd.before, { preservePinned: cmd.preservePinned, placement: cmd.placement })) {
          server.broadcast({ type: "conversation_moved", ...convStore.listSidebarState() });
        }
        break;
      }

      case "delete_folder": {
        const mode = cmd.mode ?? "recursive";
        const deletedConvIds = mode === "recursive" ? convStore.listFolderConversationIds(cmd.folderId) : [];
        if (convStore.deleteFolder(cmd.folderId, mode)) {
          for (const convId of deletedConvIds) {
            server.broadcast({ type: "conversation_deleted", convId });
          }
          server.broadcast({ type: "conversation_moved", ...convStore.listSidebarState() });
        } else {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Folder ${cmd.folderId} not found` });
        }
        break;
      }

      case "undo_delete": {
        broadcastSidebarUndoResult(client, cmd.reqId, convStore.undoDelete(), "Nothing to undo");
        break;
      }

      case "redo_delete": {
        broadcastSidebarUndoResult(client, cmd.reqId, convStore.redoDelete(), "Nothing to redo");
        break;
      }

      // ── Queue/system/history commands ─────────────────────────────

      case "queue_message": {
        const queueId = cmd.queueId?.trim();
        let queuedDraftSettings: {
          provider: import("./messages").ProviderId;
          model: import("./messages").ModelId;
          effort: import("./messages").EffortLevel;
          fastMode: boolean;
          folderId: string | null;
        } | null = null;
        if (queueId && (queueId.length > 200 || /[\r\n]/.test(queueId))) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: "Invalid queue id" });
          server.sendTo(client, { type: "queue_updated", messages: convStore.listQueuedMessages(), settledQueueIds: [queueId] });
          break;
        }
        if (queueId && convStore.getQueuedMessageById(queueId)) {
          // Idempotent replay after a socket reconnect.
          server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
          server.sendTo(client, { type: "queue_updated", messages: convStore.listQueuedMessages(), settledQueueIds: [queueId] });
          break;
        }
        if (queueId && convStore.get(cmd.convId)?.messages.some(message => message.metadata?.queueEntryId === queueId)) {
          // The daemon may have accepted and removed this entry before the
          // caller observed its acknowledgement. Durable history deduplicates
          // that replay as well as queue-file crash recovery.
          server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
          server.sendTo(client, { type: "queue_updated", messages: convStore.listQueuedMessages(), settledQueueIds: [queueId] });
          break;
        }

        if (cmd.source === "global-idle" && cmd.target === "new-conversation") {
          if (!isSafeClientConversationId(cmd.convId) || convStore.get(cmd.convId)) {
            server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: "Invalid or duplicate client-supplied conversation id" });
            server.sendTo(client, { type: "queue_updated", messages: convStore.listQueuedMessages(), ...(queueId ? { settledQueueIds: [queueId] } : {}) });
            break;
          }
          const defaults = effectiveConversationDefaults();
          const provider = cmd.provider ?? inferProviderForModel(cmd.model) ?? defaults.provider;
          if (!getProvider(provider)) {
            server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Unknown provider: ${provider}` });
            server.sendTo(client, { type: "queue_updated", messages: convStore.listQueuedMessages(), ...(queueId ? { settledQueueIds: [queueId] } : {}) });
            break;
          }
          if (cmd.model && !isKnownModel(provider, cmd.model) && !allowsCustomModels(provider)) {
            server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: unknownModelMessage(provider, cmd.model) });
            server.sendTo(client, { type: "queue_updated", messages: convStore.listQueuedMessages(), ...(queueId ? { settledQueueIds: [queueId] } : {}) });
            break;
          }
          const model = cmd.model ?? (provider === defaults.provider ? defaults.model : getDefaultModel(provider));
          const effort = normalizeEffort(provider, model, cmd.effort ?? effortDefaultForSelection(provider, model));
          if (cmd.fastMode === true && !supportsFastMode(provider)) {
            server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Fast mode is only available for ${provider} conversations that support it.` });
            server.sendTo(client, { type: "queue_updated", messages: convStore.listQueuedMessages(), ...(queueId ? { settledQueueIds: [queueId] } : {}) });
            break;
          }
          const fastMode = (cmd.fastMode ?? fastDefaultForSelection(provider, model)) && supportsFastMode(provider);
          const folderId = cmd.folderId ?? null;
          if (folderId && !convStore.listSidebarState().folders.some(folder => folder.id === folderId)) {
            server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Folder ${folderId} not found` });
            server.sendTo(client, { type: "queue_updated", messages: convStore.listQueuedMessages(), ...(queueId ? { settledQueueIds: [queueId] } : {}) });
            break;
          }
          queuedDraftSettings = { provider, model, effort, fastMode, folderId };
        } else if (!convStore.get(cmd.convId)) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
          server.sendTo(client, { type: "queue_updated", messages: convStore.listQueuedMessages(), ...(queueId ? { settledQueueIds: [queueId] } : {}) });
          break;
        }

        if (cmd.source === "global-idle") {
          convStore.pushGlobalIdleQueuedMessage(cmd.convId, cmd.text, cmd.images, {
            id: queueId,
            target: cmd.target ?? "conversation",
            provider: queuedDraftSettings?.provider ?? cmd.provider,
            model: queuedDraftSettings?.model ?? cmd.model,
            effort: queuedDraftSettings?.effort ?? cmd.effort,
            fastMode: queuedDraftSettings?.fastMode ?? cmd.fastMode,
            folderId: queuedDraftSettings?.folderId ?? cmd.folderId,
            waitTarget: cmd.waitTarget,
          });
        } else {
          convStore.pushQueuedMessage(cmd.convId, cmd.text, cmd.timing, cmd.images, undefined, undefined, queueId);
        }
        if (queuedDraftSettings) {
          const { provider, model, effort, fastMode, folderId } = queuedDraftSettings;
          // Queue persistence happens first. If the daemon dies before creation,
          // the scheduler reconstructs this draft from the captured settings.
          convStore.create(cmd.convId, provider, model, PENDING_TITLE, effort, fastMode, folderId);
          server.sendTo(client, {
            type: "conversation_created",
            reqId: cmd.reqId,
            convId: cmd.convId,
            provider,
            model,
            effort,
            fastMode,
          });
          broadcastConversationUpdated(server, cmd.convId);
          startTitleGeneration(server, cmd.convId, { extraContext: cmd.text });
        }
        server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
        log("info", `handler: queued ${cmd.timing} message for ${cmd.convId}: "${cmd.text.slice(0, 50)}"`);
        break;
      }

      case "unqueue_message": {
        const ok = cmd.queueId
          ? convStore.removeQueuedMessageById(cmd.queueId)
          : (cmd.convId && cmd.text ? convStore.removeQueuedMessage(cmd.convId, cmd.text) : false);
        server.sendTo(client, { type: "ack", reqId: cmd.reqId, ...(cmd.convId ? { convId: cmd.convId } : {}) });
        if (cmd.queueId) {
          server.sendTo(client, { type: "queue_updated", messages: convStore.listQueuedMessages(), settledQueueIds: [cmd.queueId] });
        }
        if (ok) log("info", `handler: unqueued message ${cmd.queueId ?? `${cmd.convId}: ${cmd.text?.slice(0, 50)}`}`);
        break;
      }

      case "update_queued_message": {
        const ok = convStore.updateQueuedMessage(cmd.queueId, cmd.text, cmd.timing, cmd.images);
        if (ok) server.sendTo(client, { type: "ack", reqId: cmd.reqId });
        else server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Queued message ${cmd.queueId} not found` });
        break;
      }

      case "move_queued_message": {
        const exists = !!convStore.getQueuedMessageById(cmd.queueId);
        const moved = convStore.moveQueuedMessage(cmd.queueId, cmd.direction);
        if (moved || exists) server.sendTo(client, { type: "ack", reqId: cmd.reqId });
        else server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Queued message ${cmd.queueId} not found` });
        break;
      }

      case "set_system_instructions": {
        const ok = convStore.setSystemInstructions(cmd.convId, cmd.text);
        if (ok) {
          server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
          broadcastConversationInstructionsUpdated(server, cmd.convId, cmd.text);
          log("info", `handler: system instructions ${cmd.text ? "set" : "cleared"} for ${cmd.convId}`);
        } else {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
        }
        break;
      }

      case "load_folder_instructions": {
        const text = convStore.getFolderInstructions(cmd.folderId);
        if (text !== null) {
          server.sendTo(client, { type: "folder_instructions_loaded", reqId: cmd.reqId, folderId: cmd.folderId, text });
        } else {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Folder ${cmd.folderId} not found` });
        }
        break;
      }

      case "set_folder_instructions": {
        const ok = convStore.setFolderInstructions(cmd.folderId, cmd.text);
        if (ok) {
          broadcastFolderInstructionsUpdated(server, cmd.folderId, cmd.text.trim(), cmd.reqId);
          log("info", `handler: folder instructions ${cmd.text.trim() ? "set" : "cleared"} for ${cmd.folderId}`);
        } else {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Folder ${cmd.folderId} not found` });
        }
        break;
      }

      case "unwind_conversation": {
        // Reconnecting clients can replay this before restoring their socket
        // subscription. Subscribe even if validation later rejects the unwind so
        // an error cannot leave the active TUI detached from future events.
        server.subscribe(client, cmd.convId);
        const ok = await convStore.unwindTo(cmd.convId, cmd.userMessageIndex);
        if (!ok) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Cannot unwind conversation ${cmd.convId}` });
          break;
        }
        log("info", `handler: unwound conversation ${cmd.convId} to before user message ${cmd.userMessageIndex}`);
        // Respond directly to the editor with the full conversation payload, then
        // broadcast the canonical truncated history to every subscriber.  Ctrl+W
        // is a real history mutation, not a stale same-conversation refresh; all
        // open TUIs must discard any local assistant tail that lived past the
        // unwind point.
        sendCompactConversationLoaded(client, cmd.convId, cmd.reqId);
        sendCompactHistoryUpdated(cmd.convId, true);
        broadcastConversationUpdated(server, cmd.convId);
        break;
      }

      case "load_tool_outputs": {
        const outputs = convStore.getToolOutputs(cmd.convId);
        if (!outputs) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
          break;
        }
        server.sendTo(client, { type: "tool_outputs_loaded", reqId: cmd.reqId, convId: cmd.convId, outputs });
        break;
      }

      case "load_conversation": {
        if (cmd.turns !== undefined && (!Number.isSafeInteger(cmd.turns) || cmd.turns < 1 || cmd.turns > 100)) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: "Invalid conversation history turn count" });
          break;
        }
        if (cmd.turns !== undefined) client.capabilities?.add("history-pagination");
        const data = sendCompactConversationLoaded(client, cmd.convId, cmd.reqId, cmd.turns);
        if (!data) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
          break;
        }
        server.subscribe(client, cmd.convId);
        // After subscribing, send a fresh streaming snapshot for late-join catch-up.
        // This covers any chunks emitted between the initial load snapshot and the
        // moment the new subscriber was attached.
        if (convStore.isStreaming(cmd.convId)) {
          const catchupData = getRenderSnapshot(cmd.convId) ?? data;
          const pendingAI = catchupData.pendingAI;
          if (pendingAI) {
            server.sendTo(client, {
              type: "streaming_started",
              convId: catchupData.convId,
              provider: catchupData.provider,
              model: catchupData.model,
              streamSeq: convStore.getStreamSeq(cmd.convId),
              snapshotKind: "catchup",
              startedAt: pendingAI.metadata?.startedAt ?? Date.now(),
              blocks: pendingAI.blocks,
              blockOffset: pendingAI.blockOffset,
              tokens: pendingAI.metadata?.tokens ?? 0,
              compactionStartedAt: convStore.getContextCompactionStartedAt(cmd.convId) ?? null,
            });
          }
        }
        // Clear unread when a client views the conversation
        if (convStore.clearUnread(data.convId)) {
          broadcastConversationUpdated(server, data.convId);
        }
        break;
      }

      case "load_conversation_history": {
        if (!Number.isSafeInteger(cmd.beforeEntryIndex) || cmd.beforeEntryIndex < 0
            || !Number.isSafeInteger(cmd.turns) || cmd.turns < 1 || cmd.turns > 100) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: "Invalid conversation history page request" });
          break;
        }
        client.capabilities?.add("history-pagination");
        const sent = sendCompactConversationHistory(
          client,
          cmd.convId,
          cmd.beforeEntryIndex,
          cmd.turns,
          cmd.reqId,
        );
        if (!sent) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
        }
        break;
      }

      // ── Utility/tool/auth commands ────────────────────────────────

      case "get_system_prompt": {
        const instructions = cmd.convId ? convStore.getEffectiveSystemInstructions(cmd.convId) : null;
        server.sendTo(client, {
          type: "system_prompt",
          reqId: cmd.reqId,
          systemPrompt: buildSystemPrompt({
            conversationInstructions: instructions ?? undefined,
            conversationId: cmd.convId,
          }),
        });
        break;
      }

      case "llm_complete": {
        const provider = cmd.provider ?? inferProviderForModel(cmd.model) ?? effectiveConversationDefaults().provider;
        if (!getProvider(provider)) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Unknown provider: ${provider}` });
          break;
        }
        const model = cmd.model ?? modelDefaultForProvider(provider);
        if (cmd.model && !isKnownModel(provider, cmd.model) && !allowsCustomModels(provider)) {
          server.sendTo(client, {
            type: "error",
            reqId: cmd.reqId,
            message: unknownModelMessage(provider, cmd.model),
          });
          break;
        }
        // Default must exceed the thinking budget (10000) for non-adaptive
        // models, otherwise all tokens go to thinking and text is empty.
        const maxTokens = cmd.maxTokens ?? 16000;
        log("info", `handler: llm_complete (provider=${provider}, model=${model}, maxTokens=${maxTokens}, input=${cmd.userText.length} chars)`);

        // Fire-and-forget — ack immediately, send result when ready
        server.sendTo(client, { type: "ack", reqId: cmd.reqId });

        complete(cmd.system, cmd.userText, {
          provider,
          model,
          maxTokens,
          effort: effortDefaultForSelection(provider, model),
          serviceTier: fastDefaultForSelection(provider, model) && supportsFastMode(provider) ? "fast" : undefined,
          tracking: { source: cmd.trackingSource ?? "llm_complete" },
        })
          .then((result) => {
            server.sendTo(client, { type: "llm_complete_result", reqId: cmd.reqId, text: result.text });
            broadcastTokenStats();
          })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            log("error", `handler: llm_complete failed: ${msg}`);
            server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `llm_complete failed: ${msg}` });
          });
        break;
      }

      case "transcribe_audio": {
        const audioBytes = Buffer.from(cmd.audioBase64, "base64");
        log("info", `handler: transcribe_audio (${audioBytes.length} bytes)`);
        server.sendTo(client, { type: "ack", reqId: cmd.reqId });

        transcribeAudioBytes(audioBytes, { mimeType: cmd.mimeType })
          .then((text) => {
            server.sendTo(client, { type: "transcription_result", reqId: cmd.reqId, text });
          })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            log("error", `handler: transcribe_audio failed: ${msg}`);
            server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Voice transcription failed: ${msg}` });
          });
        break;
      }

      case "login": {
        // Fire-and-forget — ack immediately, send result when ready
        server.sendTo(client, { type: "ack", reqId: cmd.reqId });

        const statusMessages = {
          already_authenticated: (e: string) => `Already authenticated as ${e}`,
          refreshed: (e: string) => `Session refreshed (${e})`,
          logged_in: (e: string) => `Authenticated as ${e}`,
        };

        const provider = cmd.provider ?? getDefaultProvider().id;

        if (provider === "openai" && cmd.action) {
          if (rejectDuringOpenAIAccountMutation(client, cmd.reqId)) break;
          if (rejectOpenAIAccountMutationWhileStreaming(client, cmd.reqId)) break;
          if (cmd.action === "remove") {
            try {
              // Account-pool mutations are synchronous. Keep them on this event
              // loop turn so a new provider stream cannot start in the gap
              // between the streaming check and the selected-account change.
              const removed = removeOpenAIAccount(cmd.target);
              invalidateCredentialsCache("openai");
              const label = removed.email ?? removed.displayName ?? removed.accountId ?? `#${removed.index}`;
              server.sendTo(client, { type: "auth_status", reqId: cmd.reqId, message: `Removed OpenAI account ${label}.\n\n${formatOpenAIAccountList()}` });
              broadcastToolsAvailable();
              refreshUsage(provider, (usage) => broadcastUsage(provider, usage));
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              log("error", `handler: openai account remove failed: ${msg}`);
              server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `OpenAI account remove failed: ${msg}` });
            }
            break;
          }

          if (cmd.action === "add") {
            openAIAccountMutationInFlight = true;
            void addOpenAIAccount({
              onProgress: (msg) => {
                server.sendTo(client, {
                  type: "auth_status",
                  reqId: cmd.reqId,
                  message: msg === "Opening browser for OpenAI authentication..."
                    ? "Preparing OpenAI authentication link..."
                    : msg,
                });
              },
              onOpenUrl: (url) => {
                server.sendTo(client, {
                  type: "auth_status",
                  reqId: cmd.reqId,
                  message: `Paste this URL into a browser to add an OpenAI account:\n\n${url}\n\nOn a remote or headless machine, use /login openai add code instead.`,
                });
                return true;
              },
              onDeviceCode: (deviceCode) => {
                server.sendTo(client, { type: "auth_status", reqId: cmd.reqId, deviceCode });
              },
            }, cmd.method ? { method: cmd.method } : undefined).then((result) => {
              invalidateCredentialsCache("openai");
              const label = result.profile?.email ?? result.profile?.displayName ?? provider;
              server.sendTo(client, { type: "auth_status", reqId: cmd.reqId, message: `Added OpenAI account ${label}.\n\n${formatOpenAIAccountList()}` });
              log("info", `handler: openai account added (${label})`);
              broadcastToolsAvailable();
              refreshUsage(provider, (usage) => broadcastUsage(provider, usage));
              void refreshProviders(true).then((changed) => {
                if (changed) broadcastToolsAvailable();
              }).catch((err) => {
                log("warn", `handler: provider refresh after OpenAI account add failed: ${err instanceof Error ? err.message : err}`);
              });
            }).catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              log("error", `handler: openai account add failed: ${msg}`);
              server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `OpenAI account add failed: ${msg}` });
            }).finally(() => {
              openAIAccountMutationInFlight = false;
            });
            break;
          }

          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Unsupported OpenAI login action: ${cmd.action}` });
          break;
        }

        if (provider === "openai") {
          if (rejectDuringOpenAIAccountMutation(client, cmd.reqId)) break;
          // Plain /login is same-account recovery, not an account switch. Keep
          // active turns alive while OAuth replaces rejected credentials; their
          // OpenAI turn sessions will detect the auth fingerprint change and
          // reconnect from the last completed round. Explicit add/remove/switch
          // operations remain blocked above while any OpenAI turn is streaming.
          openAIAccountMutationInFlight = true;
        }
        const loginOptions = {
          ...(cmd.apiKey ? { apiKey: cmd.apiKey } : {}),
          ...(cmd.method ? { method: cmd.method } : {}),
          ...(provider === "openai" && hasStreamingOpenAIConversation() ? { requireSameAccount: true } : {}),
        };
        void ensureAuthenticated(provider, {
          onProgress: (msg) => {
            server.sendTo(client, { type: "auth_status", reqId: cmd.reqId, message: msg });
          },
          onOpenUrl: (url) => {
            server.sendTo(client, { type: "auth_status", reqId: cmd.reqId, openUrl: url });
            return true;
          },
          onDeviceCode: (deviceCode) => {
            server.sendTo(client, { type: "auth_status", reqId: cmd.reqId, deviceCode });
          },
        }, loginOptions).then(({ status, email }) => {
          const label = email ?? provider;
          server.sendTo(client, { type: "auth_status", reqId: cmd.reqId, message: statusMessages[status](label) });
          log("info", `handler: login ${status} (${label})`);
          broadcastToolsAvailable();
          refreshUsage(provider, (usage) => broadcastUsage(provider, usage));
          void refreshProviders(true).then((changed) => {
            if (changed) broadcastToolsAvailable();
          }).catch((err) => {
            log("warn", `handler: provider refresh after login failed: ${err instanceof Error ? err.message : err}`);
          });
        }).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          log("error", `handler: login failed: ${msg}`);
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Login failed: ${msg}` });
        }).finally(() => {
          if (provider === "openai") openAIAccountMutationInFlight = false;
        });
        break;
      }

      case "account": {
        server.sendTo(client, { type: "ack", reqId: cmd.reqId });
        const provider = cmd.provider ?? "openai";
        if (provider !== "openai") {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Account switching is only supported for OpenAI.` });
          break;
        }

        if (!cmd.target?.trim()) {
          server.sendTo(client, { type: "auth_status", reqId: cmd.reqId, message: formatOpenAIAccountList() });
          break;
        }

        if (rejectOpenAIAccountMutationWhileStreaming(client, cmd.reqId)) break;
        if (rejectDuringOpenAIAccountMutation(client, cmd.reqId)) break;

        try {
          // See the account-removal path above: do not yield between checking
          // active streams and changing the account used by future requests.
          const switched = switchOpenAIAccount(cmd.target);
          invalidateCredentialsCache("openai");
          const label = switched.email ?? switched.displayName ?? switched.accountId ?? `account-${switched.index}`;
          server.sendTo(client, { type: "auth_status", reqId: cmd.reqId, message: `Switched OpenAI account to ${label}.\n\n${formatOpenAIAccountList()}` });
          broadcastToolsAvailable();
          refreshUsage(provider, (usage) => broadcastUsage(provider, usage));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log("error", `handler: openai account switch failed: ${msg}`);
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `OpenAI account switch failed: ${msg}` });
        }
        break;
      }

      case "logout": {
        const provider = cmd.provider ?? getDefaultProvider().id;
        if (provider === "openai" && rejectDuringOpenAIAccountMutation(client, cmd.reqId)) break;
        if (provider === "openai" && rejectOpenAIAccountMutationWhileStreaming(client, cmd.reqId)) break;
        clearAuth(provider);
        clearUsage(provider);
        broadcastUsage(provider, null);
        broadcastToolsAvailable();
        server.sendTo(client, { type: "auth_status", reqId: cmd.reqId, message: `Logged out from ${provider}` });
        log("info", `handler: logout (${provider})`);
        break;
      }

      default: {
        const unknown = cmd as Record<string, unknown>;
        server.sendTo(client, {
          type: "error",
          reqId: unknown.reqId as string | undefined,
          message: `Unknown command: ${unknown.type}`,
        });
      }
    }
  };
}
