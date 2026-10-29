import { fastModeServiceTier, isFastMode, type FastMode } from "@exocortex/shared/messages";
import { daybreakSelectionError } from "./providers/registry";
/**
 * Command handler for exocortexd.
 *
 * Routes IPC commands to the appropriate action. Thin dispatcher —
 * orchestration lives in orchestrator.ts, conversation data
 * transformations live in conversations.ts, usage state lives
 * in usage.ts.
 */

import { log } from "./log";
import { isSqliteConversationStore } from "./persistence";
import { scheduleConversationPrewarm,loadToolOutputsOffThread } from "./conversation-loader";
import { ConversationIntegrityError } from "./checkpoint-tail-integrity";
import { localMacroEnvironment } from "@exocortex/shared/macro-environment";
import type { UserMacro } from "@exocortex/shared/user-macros";
import { deleteUserMacro, listUserMacros, saveUserMacro } from "./user-macros";
import { getDaemonUpdateStatus, peekDaemonUpdateStatus } from "./update-status";
import { setApiKeyUsageRecordedListener } from "./providers/openai/api-key-usage";
import { API_CREDIT_ACCOUNT_KEY_PREFIX } from "./providers/anthropic/api-credits";
import { setCreditSyncListener } from "./providers/anthropic/credit-sync";
import { emitClaudeAccountsChanged } from "./providers/anthropic/account-events";
import { encodeHistoryDelta } from "@exocortex/shared/history-delta";
import { effectiveConversationDefaults } from "@exocortex/shared/config";
import { isDurationMs } from "@exocortex/shared/duration";
import { experimentalFeatures } from "./experimental";
import { conversationDefaultsSnapshot, resetDaemonConversationDefaults, setDaemonConversationDefaults } from "./conversation-defaults";
import { consumeUsageReset, refreshUsage, handleUsageHeaders, getLastUsage, clearUsage } from "./usage";
import { connectivity } from "./connectivity";
import { orchestrateCompactConversation, orchestrateGoalCycle, orchestrateReplayConversation, orchestrateSendMessage, type AssistantTurnOutcome } from "./orchestrator";
import { complete } from "./llm";
import { buildClaudeCodeSystemAppend, buildSystemPrompt, getBaseInstructions, getUserAddendum, reloadUserAddendum, setUserAddendum } from "./system";
import { createConversationWorkspace, ensureConversationWorkspace } from "./workspace-service";
import { scopedSubagentPromptOptions } from "./subagent-policy";
import { describeToolInstructions } from "./tool-instructions";
import { saveToolInstructions, ToolInstructionsSaveError } from "./tool-instructions-save";
import { assertDelegationModel, parseRequestedModel, resolveDelegationModel } from "./delegation-models";
import { getConversationToolNames, getToolDisplayInfo } from "./tools/registry";
import { getExternalToolStyles, manageExternalToolDaemon } from "./external-tools";
import { EFFORT_LEVELS, SUBAGENTS_FOLDER_NAME, isQueuedObligation, type Block, type UserMessageAutomation } from "./messages";
import { describeSubagentPendingWork } from "./subagent-pending-work";
import { getDefaultProvider, getDefaultModel, getProvider, getProviders, isKnownModel, allowsCustomModels, refreshProviders, normalizeEffort, supportsEffort, getSupportedEfforts, supportsFastMode, supportsImageInputs } from "./providers/registry";
import { transcribeAudioBytes } from "./transcription";
import { generateImage } from "./providers/openai/image-generation";
import { startTitleGeneration, isPendingTitle, PENDING_TITLE } from "./titlegen";
import * as convStore from "./conversations";
import { rememberSentImages, resolveImageForPreview } from "./image-requests";
import { cachedImagePreview, renderImagePreview, validatePreviewRequest, isImageId } from "./attachments";
import { DaemonServer, broadcastUsageUpdate, type ConnectedClient } from "./server";
import { isSidebarDigest, sidebarListDelta } from "@exocortex/shared/sidebar-digest";
import { isSidebarViewHint, sidebarFirstPageConversationIds, sidebarFolderConversationCounts } from "@exocortex/shared/sidebar-first-page";
import type { Command, Event, SidebarItemOrderUpdate } from "./protocol";
import { clearAuth, ensureAuthenticated, getAuthByProvider, getAuthInfoByProvider, hasConfiguredCredentials, invalidateCredentialsCache } from "./auth";
import { addAccount as addOpenAIAccount, listAccounts as listOpenAIAccounts, removeAccount as removeOpenAIAccount, switchAccount as switchOpenAIAccount } from "./providers/openai/auth";
import { getProviderAdapter } from "./providers/catalog";
import { getTokenStatsSnapshot } from "./token-stats";
import {
  broadcastConversationHistoryUpdated,
  broadcastConversationInstructionsUpdated,
  broadcastConversationUpdated,
  broadcastFolderInstructionsUpdated,
} from "./conversation-events";
import { applyUserGoalAction, setGoal as setConversationGoal } from "./goals";
import { scheduleGoalTimeLimit } from "./goal-time-limit";
import { createExocortexToolRuntime } from "./exocortex-tool-runtime";
import { attachClientHost, clientExecAlive, noteUserWroteFrom, settleClientExec } from "./client-hosts";
import { pendingTurnNotices, turnNoticeMessages } from "./turn-notices";
import { ProviderProxyManager, setActiveProviderProxyManager } from "./provider-proxy/manager";
import { ProviderProxyEndpoint } from "./provider-proxy/endpoint";
import { remoteAccountsSource } from "./provider-proxy/remote-accounts";
import { createProxiedClaudeRouter } from "./provider-proxy/claude-routing";
import type { ProviderProxyLinkCommand } from "@exocortex/shared/provider-proxy";
import type { BackgroundTaskCompletion, ExocortexToolRuntime } from "./tools/types";
import { getSubagentParentConversationId, isSubagentActive, listActiveConversationTasks, setSubagentActive, stopBackgroundTask } from "./conversation-activity";
import {
  acknowledgeSubagentNotification,
  beginPendingSubagentNotification,
  cancelRunningSubagentNotifications,
  followUpTrigger,
  hasSubagentNotificationBeenDelivered,
  hasSubagentTaskStarted,
  listPendingSubagentNotifications,
  registerSubagentNotificationRuntime,
  settlePendingSubagentNotifications,
  type PendingSubagentNotification,
} from "./subagent-notifications";
import { beginDaemonShutdown, getDaemonShutdownMode } from "./daemon-lifecycle";
import { prepareCatchableShutdownForReplay } from "./restart-recovery";
import { PREPARE_RESTART_MAX_SETTLE_MS, writeActiveGoalRestartMarker } from "./restart-markers";
import { buildBackgroundTaskNotificationText } from "./background-task-notifications";
import { configureChronoService, cancelDeferredChronoSleep } from "./chrono-service";
import { cancelSuspendedTurn } from "./suspended-turns";
import { runChronoCommand } from "./chrono-commands";
import { inlineLongSleepStartedAt } from "@exocortex/shared/chrono";
import { configureClaudeCodeSessions } from "./providers/anthropic/session";
import { abandonAppCreate, appConversationInfo, appConversationOwner, appTitleFromPrompt, attachAppConversation, checkAppToolsForModel, configureAppApi, dropTurnAwait, endAppConversation, endAppSession, ensureAppFolder, finishAppRun, holdAppCommandUntilReady, listAppConversations, markAppApiReady, parseAppCreate, registerAppCreate, registerTurnAwait, setAppConversationOwner, shutdownAppConversations, welcomeAppClient, type AppCreateSpec } from "./app-api";
import { getAppRecord, isAppConversation, isEphemeralConversation, isHiddenConversation, touchAppConversation } from "./app-registry";
import { appToolBroker } from "./app-tools";
import { addClaudeAccount, claudeLoginCommand, removeClaudeAccount } from "./providers/anthropic/accounts";
import { claudeAccountReports } from "./providers/anthropic/account-pool";
import { formatClaudeAccountReports } from "./providers/anthropic/account-report";
import { createAccountsWatch } from "./accounts-watch";
import { DISPLAY_BLOCKS_RESPONSE_BYTES, HISTORY_PAGE_BYTE_BUDGET, INITIAL_HISTORY_TURNS, MAX_DISPLAY_BLOCK_RANGES, MAX_HISTORY_REQUEST_TURNS, buildHistoryUpdatedEvents, isValidHistoryViewport, isValidInitialBackfill, compactHistoryImages, pageDisplayHistory, type HistoryViewport, type HistoryWindowOptions } from "./history-pagination";
import { PERFORMANCE_PROFILING_ENABLED } from "@exocortex/shared/performance-profiling";
import { randomUUID } from "crypto";
import { isDeepStrictEqual } from "node:util";
import {
  buildExternalNotificationEnvelope,
  hasExternalNotificationReceipt,
  listExternalNotificationSources,
  listExternalNotificationSubscriptions,
  recordExternalNotificationReceipt,
  registerExternalNotificationSource,
  setExternalNotificationsChangedListener,
  subscribeExternalNotification,
  unsubscribeExternalNotification,
  updateExternalNotificationSubscription,
} from "./external-notifications";
import { BtwSessionManager } from "./btw";
import { enqueueExternalNotificationSoftWake } from "./external-notification-soft-wakes";
import { listPathDirectoryWithLookahead } from "./path-completion";
import { resolveFileLink } from "./file-links";

// ── Handler ─────────────────────────────────────────────────────────

let queueSchedulerGeneration = 0;

export interface HandlerLifecycle {
  /** Restart the process that owns this exact server/socket instance. */
  requestRestart?: () => void;
  /** How long a prepared restart may wait for its service before restarting itself. */
  preparedRestartTimeoutMs?: number;
}

export interface DaemonCommandHandler {
  (client: ConnectedClient, cmd: Command): Promise<void>;
  stop(): Promise<void>;
  backgroundTaskComplete(convId: string, completion: BackgroundTaskCompletion): void;
  /** /proxy links of this daemon; main.ts starts and stops them. */
  providerProxies: ProviderProxyManager;
  /** Release queue delivery held by `holdQueueDeliveryUntilReady`. */
  startQueueDelivery(): void;
}

export interface HandlerOptions extends HandlerLifecycle {
  providerProxies?: ProviderProxyManager;
  /**
   * Daemon boot: dispatch no queued message until startup recovery has adopted
   * surviving Claude Code processes and scheduled interrupted-turn replays.
   * Otherwise a preserved queue entry starts a fresh turn that replaces the
   * adopted process, or answers instead of the interrupted turn's replay.
   */
  holdQueueDeliveryUntilReady?: boolean;
}

/**
 * A prompt the `exo` CLI sends or queues (`delegation`) is never the owner's
 * keyboard: it is stored as an automated exo_send from the conversation that
 * ran the CLI, when that conversation exists, else from `fallbackSourceId`.
 */
/** get_history_revisions answers at most this many conversations. */
const MAX_HISTORY_REVISION_IDS = 512;
/** Revision changes within this window go out as one history_revisions push. */
let historyRevPushDelayMs = 250;
export function setHistoryRevPushDelayForTest(ms: number): void { historyRevPushDelayMs = ms; }

export function cliDelegationAutomation(
  cmd: { delegation?: boolean; sender?: unknown },
  fallbackSourceId?: string,
): UserMessageAutomation | undefined {
  if (!cmd.delegation) return undefined;
  const sender = typeof cmd.sender === "string" ? cmd.sender.trim() : "";
  const sourceId = sender && convStore.hasConversation(sender) ? sender : fallbackSourceId;
  return { kind: "exo_send", ...(sourceId ? { sourceId } : {}) };
}

export function createHandler(server: DaemonServer, options: HandlerOptions = {}): DaemonCommandHandler {
  const lifecycle = options;
  // App clients' commands wait for startup recovery like queued messages do (startQueueDelivery).
  const stopAppApi = configureAppApi(server, { holdUntilReady: options.holdQueueDeliveryUntilReady === true });
  /** The queue as the TUI sees it: hidden app conversations' entries are not shown. */
  const visibleQueuedMessages = () => convStore.listQueuedMessages().filter(message => !isHiddenConversation(message.convId));

  // History revisions of conversations that clients see (not app ones).
  const visibleHistoryRevs = (ids: Iterable<string>): Record<string, string> => {
    const revs: Record<string, string> = {};
    for (const id of ids) {
      if (!isHiddenConversation(id) && convStore.getSummary(id)) revs[id] = convStore.getHistoryRev(id);
    }
    return revs;
  };
  // Pushed revisions: coalesced, so a running turn sends a few small events a second at most.
  const changedHistoryRevs = new Set<string>();
  let historyRevTimer: ReturnType<typeof setTimeout> | null = null;
  convStore.setHistoryRevListener((id) => {
    changedHistoryRevs.add(id);
    if (historyRevTimer) return;
    historyRevTimer = setTimeout(() => {
      historyRevTimer = null;
      const revs = visibleHistoryRevs(changedHistoryRevs);
      changedHistoryRevs.clear();
      if (Object.keys(revs).length > 0) server.broadcastHistoryRevisions?.(revs);
    }, historyRevPushDelayMs);
    historyRevTimer.unref?.();
  });
  /**
   * Every durable entry for a conversation, delivery-suspended or not.
   * Deduplication must see entries an in-progress unwind is gating.
   */
  const queuedEntriesFor = (convId: string) => convStore.listInternalQueuedMessages()
    .filter(entry => entry.convId === convId && entry.source === "daemon");
  // ── Local helper functions ────────────────────────────────────────

  type SidebarStateSnapshot = ReturnType<typeof convStore.listSidebarState>;

  const broadcastSidebarStatePatch = (before: SidebarStateSnapshot): void => {
    const after = convStore.listSidebarState();
    const previousConversations = new Map(before.conversations.map(summary => [summary.id, summary]));
    const previousFolders = new Map(before.folders.map(folder => [folder.id, folder]));
    const nextConversationIds = new Set(after.conversations.map(summary => summary.id));
    const nextFolderIds = new Set(after.folders.map(folder => folder.id));
    const conversations = after.conversations.filter(summary => (
      !isDeepStrictEqual(previousConversations.get(summary.id), summary)
    ));
    const folders = after.folders.filter(folder => (
      !isDeepStrictEqual(previousFolders.get(folder.id), folder)
    ));
    const removedConversationIds = before.conversations
      .filter(summary => !nextConversationIds.has(summary.id))
      .map(summary => summary.id);
    const removedFolderIds = before.folders
      .filter(folder => !nextFolderIds.has(folder.id))
      .map(folder => folder.id);
    const event: Extract<Event, { type: "sidebar_state_patched" }> = {
      type: "sidebar_state_patched",
      ...(conversations.length > 0 ? { conversations } : {}),
      ...(folders.length > 0 ? { folders } : {}),
      ...(removedConversationIds.length > 0 ? { removedConversationIds } : {}),
      ...(removedFolderIds.length > 0 ? { removedFolderIds } : {}),
    };
    const capabilitySender = (server as DaemonServer & {
      broadcastSidebarStatePatched?: DaemonServer["broadcastSidebarStatePatched"];
    }).broadcastSidebarStatePatched;
    if (capabilitySender) {
      capabilitySender.call(server, event, () => ({ type: "conversation_moved", ...after }));
    } else {
      // Minimal test doubles and older embedded servers retain the full snapshot.
      server.broadcast({ type: "conversation_moved", ...after });
    }
  };

  const broadcastSidebarItemOrderUpdates = (updates: SidebarItemOrderUpdate[]): void => {
    const event: Extract<Event, { type: "sidebar_items_reordered" }> = { type: "sidebar_items_reordered", updates };
    const capabilitySender = (server as DaemonServer & {
      broadcastSidebarItemsReordered?: DaemonServer["broadcastSidebarItemsReordered"];
    }).broadcastSidebarItemsReordered;
    if (capabilitySender) {
      capabilitySender.call(server, event, () => ({ type: "conversation_moved", ...convStore.listSidebarState() }));
    } else {
      // Minimal test doubles and older embedded servers retain the canonical full snapshot.
      server.broadcast({ type: "conversation_moved", ...convStore.listSidebarState() });
    }
  };

  let openAIAccountMutationInFlight = false;
  let openAIUsageResetInFlight = false;
  let exocortexRuntime: ExocortexToolRuntime | undefined;
  let btwManager: BtwSessionManager;
  const pendingBackgroundNotifications = new Map<string, { convId: string; completion: BackgroundTaskCompletion }>();
  const enqueueBackgroundTaskCompletion = (convId: string, completion: BackgroundTaskCompletion): void => {
    const id = `${convId}:${completion.taskId}:${completion.endedAt}`;
    pendingBackgroundNotifications.set(id, { convId, completion });
    deliverPendingBackgroundNotifications();
  };
  configureChronoService(
    (convId) => broadcastConversationUpdated(server, convId),
    async (sleep) => {
      // The scheduler has already attached the missing tool_result. Reconcile
      // clients before replaying so the resumed provider and TUI share history.
      broadcastConversationHistoryUpdated(server, sleep.conversationId);
      broadcastConversationUpdated(server, sleep.conversationId);
      const outcome = await orchestrateReplayConversation(
        server,
        null,
        undefined,
        sleep.conversationId,
        Date.now(),
        buildOrchestrationCallbacks(sleep.conversationId),
      );
      // Chrono owns a durable replay, but it does not own an unrelated active
      // detached-send notification. A lost admission must remain retryable;
      // settling by child id here would falsely report that active send failed.
      if (!outcome.ok && outcome.error === "Already streaming") {
        throw new Error(`Deferred Chrono sleep replay for ${sleep.conversationId} lost turn admission`);
      }
      if (!outcome.suspended) notificationRuntime.complete(sleep.conversationId, outcome);
    },
  );
  // Claude Code processes outliving a turn report their background tasks, and
  // queue a turn when Claude Code starts work by itself (a task finished).
  configureClaudeCodeSessions({
    tasksChanged: (convId) => broadcastConversationUpdated(server, convId),
    wake: (convId, text, wakeId) => {
      const conversation = convStore.getPolicyMetadata(convId);
      if (!conversation || getDaemonShutdownMode()) return false;
      convStore.pushQueuedMessage(
        convId,
        text,
        "next-turn",
        undefined,
        conversation.subagentMaxDepth ?? null,
        undefined,
        undefined,
        undefined,
        { kind: "background_task_completion", sourceId: wakeId },
      );
      return true;
    },
    cancelWake: (convId, wakeId) => {
      const queued = convStore.getQueuedMessages(convId).find(message => (
        message.automation?.kind === "background_task_completion" && message.automation.sourceId === wakeId
      ));
      if (queued) convStore.removeQueuedMessageById(queued.id);
    },
  });
  setExternalNotificationsChangedListener((convIds) => {
    for (const convId of convIds) broadcastConversationUpdated(server, convId);
  });

  const broadcastUsage = (provider: import("./messages").ProviderId, usage: import("./messages").UsageData | null) => {
    broadcastUsageUpdate(server, provider, usage);
  };
  // An API key's spend changes with every response, image and transcription:
  // push it as each one is counted, and again when the local day rolls over
  // (Today restarts at 0). Clients never ask; unchanged payloads aren't resent.
  setApiKeyUsageRecordedListener((accountKey) => {
    const provider = accountKey.startsWith(API_CREDIT_ACCOUNT_KEY_PREFIX) ? "anthropic" : "openai";
    broadcastUsage(provider, getLastUsage(provider));
  });
  // A Console sync changed a credit balance: the Accounts screen and the usage block show it.
  setCreditSyncListener(() => {
    emitClaudeAccountsChanged();
    broadcastUsage("anthropic", getLastUsage("anthropic"));
  });
  let apiKeyDayTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleApiKeyDayRollover = () => {
    const midnight = new Date();
    midnight.setHours(24, 0, 1, 0);
    apiKeyDayTimer = setTimeout(() => {
      broadcastUsage("openai", getLastUsage("openai"));
      scheduleApiKeyDayRollover();
    }, midnight.getTime() - Date.now());
    apiKeyDayTimer.unref?.();
  };
  scheduleApiKeyDayRollover();
  /** The Accounts screen's structured data and its live watchers (`accounts`). */
  const accountsWatch = createAccountsWatch({
    send: (client, event) => { server.sendTo(client, event); },
    onClaudeUsage: (usage) => broadcastUsage("anthropic", usage),
  });

  // ── /proxy ────────────────────────────────────────────────────────

  const providerProxies = options.providerProxies ?? new ProviderProxyManager();
  setActiveProviderProxyManager(providerProxies);
  let providerProxyBroadcastQueued = false;
  providerProxies.setListeners({
    onChange: () => {
      // Link state and the remote's account change together; send one update.
      if (providerProxyBroadcastQueued) return;
      providerProxyBroadcastQueued = true;
      queueMicrotask(() => {
        providerProxyBroadcastQueued = false;
        server.broadcast({ type: "provider_proxies", proxies: providerProxies.list() });
        broadcastToolsAvailable();
        for (const proxy of providerProxies.list()) broadcastUsage(proxy.provider, getLastUsage(proxy.provider));
      });
    },
    onAccountsChange: () => {
      // The remote's Claude pool: the bars combine it, the Accounts screen lists it.
      broadcastUsage("anthropic", getLastUsage("anthropic"));
      accountsWatch.changed();
    },
    onRouteChange: (provider) => {
      // The other account's usage must not linger: the bars follow the route.
      getProviderAdapter(provider).usage.clearUsage();
      invalidateCredentialsCache(provider);
      broadcastUsage(provider, getLastUsage(provider));
      if (hasConfiguredCredentials(provider)) refreshUsage(provider, (usage) => broadcastUsage(provider, usage));
      void refreshProviders(true).then(() => broadcastToolsAvailable()).catch((err) => {
        log("warn", `handler: provider refresh after /proxy change failed: ${err instanceof Error ? err.message : err}`);
      });
    },
  });
  /** Routes proxied Claude requests from other daemons across this daemon's accounts. */
  const proxiedClaudeRouter = createProxiedClaudeRouter();
  /** Remote end of /proxy links: one endpoint per connection that said provider_proxy_hello. */
  const providerProxyEndpoints = new Map<ConnectedClient, ProviderProxyEndpoint>();
  const providerProxyEndpointFor = (client: ConnectedClient, create: boolean): ProviderProxyEndpoint | null => {
    const existing = providerProxyEndpoints.get(client);
    if (existing || !create) return existing ?? null;
    client.providerProxyLink = true;
    const endpoint = new ProviderProxyEndpoint({
      send: (event) => { server.sendTo(client, event); },
      needsDrain: () => client.socket.writableNeedDrain,
      waitDrain: () => new Promise<void>(resolve => {
        const done = () => {
          client.socket.off("drain", done);
          client.socket.off("close", done);
          resolve();
        };
        client.socket.once("drain", done);
        client.socket.once("close", done);
      }),
    }, { accounts: remoteAccountsSource(), claudeRouter: proxiedClaudeRouter });
    providerProxyEndpoints.set(client, endpoint);
    client.socket.once("close", () => {
      endpoint.close();
      providerProxyEndpoints.delete(client);
    });
    return endpoint;
  };
  const rejectProxiedProviderAuth = (client: ConnectedClient, reqId: string | undefined, provider: string, action: string): boolean => {
    const alias = providerProxies.aliasFor(provider);
    if (!alias) return false;
    server.sendTo(client, {
      type: "auth_status",
      reqId,
      message: `${getProviderAdapter(provider as import("./messages").ProviderId).label} goes through /proxy on ${alias}, which uses that machine's login: ${action} there, or run /proxy ${provider} off first.`,
    });
    return true;
  };
  /** The sidebar bootstrap, reduced to changed rows when the client sent a digest. */
  const conversationsListFor = (client: ConnectedClient, reqId?: string): Extract<Event, { type: "conversations_list" }> => {
    const state = convStore.listSidebarState();
    const digest = client.sidebarDigest;
    if (!digest) return { type: "conversations_list", reqId, ...state };
    client.sidebarDigest = undefined;
    const delta = sidebarListDelta(state.conversations, state.folders, digest);
    return { type: "conversations_list", reqId, ...(delta ?? state) };
  };
  /**
   * The bootstrap's conversation list: with sidebar-incremental and a view
   * (and no digest, whose delta is smaller still), a first page for that view
   * and then the rest; both come from one snapshot, sent with nothing that
   * changes the sidebar in between.
   */
  const bootstrapConversationsLists = (client: ConnectedClient): Array<Extract<Event, { type: "conversations_list" }>> => {
    const view = client.sidebarView;
    client.sidebarView = undefined;
    if (!view || client.sidebarDigest || !client.capabilities?.has("sidebar-incremental")) return [conversationsListFor(client)];
    const { conversations, folders } = convStore.listSidebarState();
    const first = new Set([
      ...sidebarFirstPageConversationIds(conversations, folders, view),
      ...view.conversationIds,
      ...convStore.listQueuedMessages().map(message => message.convId),
    ]);
    for (const conversation of conversations) {
      // Rows whose state shows in folder badges, the activity panel or attention navigation.
      if (conversation.streaming || conversation.unread || conversation.providerWaiting
          || (conversation.tasks?.length ?? 0) > 0 || (conversation.subagentCount ?? 0) > 0
          || (conversation.backgroundTaskCount ?? 0) > 0) first.add(conversation.id);
    }
    const page = conversations.filter(conversation => first.has(conversation.id));
    const rest = conversations.filter(conversation => !first.has(conversation.id));
    return [
      {
        type: "conversations_list",
        conversations: page,
        folders,
        sidebarPartial: { remaining: rest.length, folderConversationCounts: sidebarFolderConversationCounts(conversations, folders) },
      },
      { type: "conversations_list", conversations: rest, sidebarRest: true },
    ];
  };
  const broadcastTokenStats = () => {
    server.broadcastLegacyTokenStats(getTokenStatsSnapshot);
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
    if (isKnownModel("openrouter", lowered)) return "openrouter";
    if (lowered.startsWith("claude-") || ["opus", "sonnet", "haiku", "fable"].includes(lowered)) return "anthropic";
    if (lowered === "pro" || lowered === "flash" || lowered.startsWith("deepseek-") || lowered.startsWith("v4-")) return "deepseek";
    if (lowered.startsWith("gpt-") || lowered.startsWith("o1") || lowered.startsWith("o3") || lowered.startsWith("o4")) return "openai";
    if (lowered === "ox" || lowered === "ox-alpha" || lowered === "ox-alpha-free") return "opencode";
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
  const fastDefaultForSelection = (provider: import("./messages").ProviderId, model: string): FastMode => {
    const defaults = effectiveConversationDefaults();
    return provider === defaults.provider && model === defaults.model && defaults.fastMode;
  };
  /** `/account claude`: list Claude accounts, or add/remove one. Routing between them is automatic. */
  const handleClaudeAccountCommand = (client: ConnectedClient, cmd: Extract<Command, { type: "account" }>): void => {
    const proxyAlias = providerProxies.aliasFor("anthropic");
    if (proxyAlias) {
      // Accounts belong to the remote: adding one needs Claude Code's own login in a terminal there.
      const pool = providerProxies.remoteAccounts();
      const count = pool?.pool.accounts.length ?? 0;
      const listed = count > 1 ? ` Its ${count} Claude accounts are on the Accounts screen (/accounts or g a).` : "";
      server.sendTo(client, {
        type: "auth_status",
        reqId: cmd.reqId,
        message: `Claude goes through /proxy on ${proxyAlias}, which runs this machine's turns on its main account.${listed} `
          + `Claude accounts are managed on ${proxyAlias}: add, remove or sign them in there (for example /ssh ${proxyAlias}, then /account claude add <name>), or run /proxy anthropic off first.`,
      });
      return;
    }
    const sendList = (prefix: string) => {
      void claudeAccountReports().then((reports) => {
        const usage = getLastUsage("anthropic");
        broadcastUsage("anthropic", usage);
        const text = formatClaudeAccountReports(reports, usage);
        server.sendTo(client, { type: "auth_status", reqId: cmd.reqId, message: prefix ? `${prefix}\n\n${text}` : text });
      }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Checking Claude accounts failed: ${msg}` });
      });
    };
    const target = cmd.target?.trim();
    if (!cmd.action) {
      sendList(target ? "Claude accounts are chosen per conversation automatically; there is nothing to switch." : "");
      return;
    }
    if (!target) {
      server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Usage: /account claude ${cmd.action} <name>` });
      return;
    }
    try {
      if (cmd.action === "add") {
        const added = addClaudeAccount(target, cmd.configDir);
        log("info", `handler: Claude account ${added.account.id} added (${added.account.configDir}, linked ${added.linked.join(", ") || "nothing"})`);
        sendList([
          `Added Claude account "${added.account.id}" (${added.created ? "created" : "using"} ${added.account.configDir}; shares sessions and settings with the main account).`,
          "Sign it in from a terminal with Claude Code's own login, then run /account claude to check it:",
          `  ${claudeLoginCommand(added.account)}`,
        ].join("\n"));
      } else {
        const removed = removeClaudeAccount(target);
        log("info", `handler: Claude account ${removed.id} removed`);
        sendList(`Removed Claude account "${removed.id}". Its directory and login are left as they are (${removed.configDir}).`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Claude account ${cmd.action} failed: ${msg}` });
    }
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
  const hasStreamingOpenAIConversation = (): boolean => (
    convStore.listSummaries().some((conversation) => conversation.provider === "openai" && conversation.streaming)
    || btwManager?.hasRunningProvider("openai") === true
  );
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

  // Every OpenAI response re-reads account headers; the registry they feed
  // rarely changes, so identical snapshots are not re-sent to every client.
  let lastToolsAvailable: string | null = null;
  const broadcastToolsAvailable = () => {
    const externalStyles = getExternalToolStyles();
    const event: Extract<Event, { type: "tools_available" }> = {
      type: "tools_available",
      macroEnvironment: localMacroEnvironment(),
      conversationDefaults: conversationDefaultsSnapshot(),
      experimental: experimentalFeatures(),
      providers: getProviders(),
      tools: getToolDisplayInfo(),
      authByProvider: getAuthByProvider(),
      authInfoByProvider: getAuthInfoByProvider(),
      ...(externalStyles.length > 0 ? { externalToolStyles: externalStyles } : {}),
      providerProxies: providerProxies.list(),
    };
    // OpenAI account switches and /proxy changes show on the Accounts screen too.
    accountsWatch.changed();
    const serialized = JSON.stringify(event);
    if (serialized === lastToolsAvailable) return;
    lastToolsAvailable = serialized;
    server.broadcast(event);
  };
  const buildOrchestrationCallbacks = (convId: string) => ({
    onHeaders: (h: Headers) => {
      const provider = convStore.getIndexedSummary(convId)?.provider ?? getDefaultProvider().id;
      if (provider === "openai") broadcastToolsAvailable();
      handleUsageHeaders(provider, h, (usage) => broadcastUsage(provider, usage));
    },
    onComplete: () => {
      const provider = convStore.getIndexedSummary(convId)?.provider ?? getDefaultProvider().id;
      refreshUsage(provider, (usage) => broadcastUsage(provider, usage));
      broadcastTokenStats();
    },
    onBackgroundTaskComplete: (completion: BackgroundTaskCompletion) => {
      enqueueBackgroundTaskCompletion(convId, completion);
    },
    exocortex: exocortexRuntime,
  });

  btwManager = new BtwSessionManager(server, {
    onHeaders: (provider, headers) => {
      if (provider === "openai") broadcastToolsAvailable();
      handleUsageHeaders(provider, headers, (usage) => broadcastUsage(provider, usage));
    },
    onComplete: (provider) => {
      refreshUsage(provider, (usage) => broadcastUsage(provider, usage));
      broadcastTokenStats();
    },
    cannotStart: (provider) => {
      const shutdownMode = getDaemonShutdownMode();
      if (shutdownMode) return `Daemon is shutting down (${shutdownMode}); refusing to start a BTW session.`;
      if (provider === "openai" && openAIAccountMutationInFlight) {
        return "Cannot start an OpenAI BTW session while account authentication is still in progress.";
      }
      return null;
    },
  });

  const getRenderSnapshot = (
    convId: string,
    diagnostics?: Partial<convStore.RenderSnapshotDiagnostics>,
  ) => convStore.getRenderSnapshot(convId, false, diagnostics);

  const shouldAutoGenerateTitle = (convId: string): boolean => {
    // App conversations never cost a title model call (docs/app-api.md).
    if (isAppConversation(convId)) return false;
    const title = convStore.getIndexedSummary(convId)?.title.trim() ?? "";
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
      const parent = convStore.getPolicyMetadata(pending.convId);
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
      const automation = { kind: "background_task_completion" as const, sourceId: pending.completion.taskId };
      const alreadyDurable = convStore.hasMessageMetadata(pending.convId, {
        "automation.kind": automation.kind, "automation.sourceId": automation.sourceId,
      }) || queuedEntriesFor(pending.convId).some(message => (
        message.automation?.kind === automation.kind
        && message.automation.sourceId === automation.sourceId
      ));
      if (!alreadyDurable) {
        // Persist every completion through the daemon-owned queue before
        // acknowledging its runner sidecar. Idle conversations drain this on the
        // next scheduler tick; streaming or temporarily unauthenticated owners
        // retain it safely across another restart.
        convStore.pushQueuedMessage(
          pending.convId,
          text,
          "next-turn",
          undefined,
          parent.subagentMaxDepth ?? null,
          undefined,
          undefined,
          undefined,
          automation,
        );
      }
      pendingBackgroundNotifications.delete(id);
      log("info", `${alreadyDurable ? "deduplicated" : "queued durable"} background task completion notification ${pending.completion.taskId} for ${pending.convId}`);
    }
  }

  const queueReadyParentNotification = (record: PendingSubagentNotification): void => {
    const alreadyQueued = queuedEntriesFor(record.parentConvId)
      .some((message) => message.subagentNotificationId === record.id);
    if (alreadyQueued) return;
    convStore.pushQueuedMessage(
      record.parentConvId,
      record.text!,
      "next-turn",
      undefined,
      convStore.getPolicyMetadata(record.parentConvId)?.subagentMaxDepth ?? null,
      record.id,
      undefined,
      undefined,
      { kind: "subagent_completion", sourceId: record.childConvId },
    );
    log("info", `handler: queued durable subagent completion notification ${record.childConvId} -> parent ${record.parentConvId}`);
  };

  /**
   * A subagent woken after its task already reported has nobody waiting on
   * this turn: a message from its parent or a sibling, its own subagent's late
   * result, a finished background task, a wake. Report the turn to its parent
   * like a task (the turn's end completes the record), unless it was started
   * detached. Runs at turn admission, so every path that starts the turn (idle
   * delivery, a queued successor, the queue pump) is covered, and when such
   * input joins a running turn that nothing reports (drainNextTurnMessages).
   * A goal continuation starts a turn after the last one reported, so it
   * reports too; a restart notice carries on a turn already accounted for.
   */
  const relaySubagentFollowUp = (
    convId: string,
    automation: UserMessageAutomation,
    text: string,
    startedAt: number,
  ): void => {
    const policy = convStore.getPolicyMetadata(convId);
    const upstreamId = policy?.subagentPolicy?.parentConversationId;
    if (!policy || !upstreamId || upstreamId === convId || policy.subagentPolicy?.detached) return;
    if (!isQueuedObligation(automation) && automation.kind !== "goal_continuation") return;
    if (!convStore.getPolicyMetadata(upstreamId)) return;
    // A running record (its task, or an exo message's own record) already reports this turn.
    if (listPendingSubagentNotifications({ childConvId: convId, state: "running" }).length > 0) return;
    try {
      beginPendingSubagentNotification({ convId: upstreamId }, convId, text, startedAt, policy.subagentMaxDepth ?? null, true,
        followUpTrigger(automation, upstreamId));
    } catch (err) {
      log("warn", `handler: could not relay follow-up of subagent ${convId} to ${upstreamId}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (setSubagentActive(upstreamId, convId, true, {
      title: convStore.subagentTaskTitle(convId) || "Subagent task",
      startedAt,
    })) broadcastConversationUpdated(server, upstreamId);
  };

  /**
   * The owner typed into a subagent (or its turn resumes their prompt): the
   * child shows as working under its parent while the turn runs. The turn is
   * theirs, so nothing reports it; its end clears the entry like any turn's.
   */
  const trackOwnerSubagentTurn = (convId: string, startedAt: number): void => {
    const policy = convStore.getPolicyMetadata(convId);
    const upstreamId = policy?.subagentPolicy?.parentConversationId;
    if (!policy || !upstreamId || upstreamId === convId || policy.subagentPolicy?.detached) return;
    if (!convStore.getPolicyMetadata(upstreamId) || isSubagentActive(upstreamId, convId)) return;
    if (setSubagentActive(upstreamId, convId, true, {
      title: convStore.subagentTaskTitle(convId) || "Subagent task",
      startedAt,
    })) broadcastConversationUpdated(server, upstreamId);
  };

  /** Sends admitted but not yet accepted; a repeated completion must not resend or queue them. */
  const deliveringNotificationIds = new Set<string>();

  const deliverReadyParentNotifications = (childConvId?: string): void => {
    for (const record of listPendingSubagentNotifications({ childConvId, state: "ready" })) {
      if (deliveringNotificationIds.has(record.id)) continue;
      if (hasSubagentNotificationBeenDelivered(record)) {
        acknowledgeSubagentNotification(record.id);
        continue;
      }
      if (record.parentConvId === record.childConvId) {
        log("warn", `handler: dropping self-notification for ${record.childConvId}`);
        acknowledgeSubagentNotification(record.id);
        continue;
      }
      const parent = convStore.getPolicyMetadata(record.parentConvId);
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
      deliveringNotificationIds.add(record.id);
      const startedAt = Date.now();
      void orchestrateSendMessage(
        server,
        null,
        undefined,
        record.parentConvId,
        record.text!,
        startedAt,
        buildOrchestrationCallbacks(record.parentConvId),
        undefined,
        {
          subagentMaxDepth: parent.subagentMaxDepth ?? null,
          subagentNotificationId: record.id,
          automation: { kind: "subagent_completion", sourceId: record.childConvId },
        },
      ).then(() => {
        deliveringNotificationIds.delete(record.id);
        // Preflight failures do not accept the user message and therefore leave
        // the durable record in place. Retry without duplicating accepted turns.
        if (listPendingSubagentNotifications().some((candidate) => candidate.id === record.id)) {
          scheduleNotificationRetry();
        }
      }).catch((err) => {
        deliveringNotificationIds.delete(record.id);
        const msg = err instanceof Error ? err.message : String(err);
        log("error", `handler: parent notification send failed for ${record.parentConvId}: ${msg}`);
        scheduleNotificationRetry();
      });
    }
  };

  const completeParentNotification = (childConvId: string, outcome: AssistantTurnOutcome): void => {
    // The turn's finalizer already did all of this; its starter resolves later,
    // after queued successors that may still be running or awaiting replay.
    if (outcome.notificationsSettled) return;
    const related = listPendingSubagentNotifications({ childConvId });
    // A daemon stop ends every turn on purpose and schedules nothing for later:
    // no "stopped" notices (a restart's aborts stay running for replay instead).
    if (outcome.aborted && !outcome.watchdog && !outcome.daemonRestart && getDaemonShutdownMode() === "stop") {
      cancelRunningSubagentNotifications(childConvId);
    }
    const reporting = related.some((record) => record.state === "running");
    settlePendingSubagentNotifications(childConvId, reporting && !outcome.aborted
      ? { ...outcome, pendingWork: describeSubagentPendingWork(childConvId) }
      : outcome);
    if (!(outcome.aborted && outcome.daemonRestart)) {
      const parentIds = new Set(
        related.filter((record) => record.trackAsSubagent).map((record) => record.parentConvId),
      );
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
    relayFollowUp: relaySubagentFollowUp,
    trackOwnerTurn: trackOwnerSubagentTurn,
  };
  registerSubagentNotificationRuntime(server, notificationRuntime);

  exocortexRuntime = createExocortexToolRuntime({
    server,
    runTurn: (convId, text, maxDepth, startedAt, automation) => {
      const turn = orchestrateSendMessage(
        server,
        null,
        undefined,
        convId,
        text,
        startedAt,
        buildOrchestrationCallbacks(convId),
        undefined,
        { subagentMaxDepth: maxDepth, automation },
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

  interface ConversationLoadMetrics {
    snapshot: Partial<convStore.RenderSnapshotDiagnostics>;
    compactMs: number;
    paginateMs: number;
    sendMs: number;
    responseBytes: number;
    responseEntries: number;
    historyTotalEntries: number;
  }

  const createConversationLoadMetrics = (): ConversationLoadMetrics => ({
    snapshot: {},
    compactMs: 0,
    paginateMs: 0,
    sendMs: 0,
    responseBytes: 0,
    responseEntries: 0,
    historyTotalEntries: 0,
  });

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

  /**
   * Clients that understand partial AI entries receive byte-bounded windows;
   * ones that fold turns and can fetch elided blocks, without the folded work.
   */
  const historyWindowOptions = (target: ConnectedClient, convId: string, folded = false): HistoryWindowOptions => ({
    ...(target.capabilities?.has("history-block-pagination") ? { byteBudget: HISTORY_PAGE_BYTE_BUDGET } : {}),
    ...(folded && target.capabilities?.has("history-folded-elision")
      ? { elideFoldedWork: true, ...(convStore.hasRunningTurn(convId) ? { turnRunning: true } : {}) }
      : {}),
  });

  const sendCompactConversationLoaded = (
    target: ConnectedClient,
    convId: string,
    reqId?: string,
    turns?: number,
    metrics?: ConversationLoadMetrics,
    cachedEntryHashes?: string[],
    viewport?: HistoryViewport,
    initialBackfillReqId?: string,
  ) => {
    const paginated = target.capabilities?.has("history-pagination") || turns !== undefined;
    const windowOptions = historyWindowOptions(target, convId, viewport?.folded === true);
    // A byte-budgeted client's viewport sizes the window in rendered rows.
    if (viewport && windowOptions.byteBudget !== undefined) {
      windowOptions.viewport = viewport;
      if (viewport.folded) windowOptions.isOwnSubagent = convStore.ownSubagentTest(convId);
      turns = MAX_HISTORY_REQUEST_TURNS;
    }
    if (paginated) {
      const snapshotDiagnostics: Partial<convStore.RenderSnapshotDiagnostics> | undefined = metrics ? {} : undefined;
      const page = convStore.getStoredDisplayPage(convId, turns ?? INITIAL_HISTORY_TURNS, undefined, snapshotDiagnostics, windowOptions);
      if (page) {
        const queued = convStore.getQueuedMessages(page.convId);
        const summary = convStore.getSummary(page.convId);
        const responseEntries = [...page.pinnedEntries, ...page.entries];
        const sendStartedAt = metrics ? performance.now() : 0;
        const btw = btwManager.getSnapshot(page.convId);
        const pending = convStore.getPendingStreamSnapshot(page.convId);
        const responseBytes = server.sendTo(target, encodeHistoryDelta({
          type: "conversation_loaded",
          reqId,
          convId: page.convId,
          provider: summary?.provider ?? page.provider,
          model: summary?.model ?? page.model,
          effort: summary?.effort ?? page.effort,
          fastMode: summary?.fastMode ?? page.fastMode,
          entries: responseEntries,
          historyStartIndex: page.startIndex,
          ...(page.startBlockIndex > 0 ? { historyStartBlockIndex: page.startBlockIndex } : {}),
          historyStartUserIndex: page.startUserIndex,
          historyTotalEntries: page.totalEntries,
          hasOlderHistory: page.hasOlder,
          ...(initialBackfillReqId && page.hasOlder ? { initialBackfillReqId } : {}),
          historyRev: convStore.getHistoryRev(page.convId),
          ...(pending ? {
            pendingAI: {
              blocks: pending.blocks,
              blockOffset: pending.blockOffset,
              metadata: pending.metadata,
            },
          } : {}),
          contextTokens: page.contextTokens,
          toolOutputsIncluded: false,
          queuedMessages: queued.length > 0 ? queued : undefined,
          goal: summary?.goal ?? null,
          btw,
        }, cachedEntryHashes), metrics !== undefined);
        if (metrics) {
          metrics.snapshot = snapshotDiagnostics ?? {};
          metrics.compactMs = 0;
          metrics.paginateMs = 0;
          metrics.sendMs = performance.now() - sendStartedAt;
          metrics.responseBytes = typeof responseBytes === "number" ? responseBytes : 0;
          metrics.responseEntries = responseEntries.length;
          metrics.historyTotalEntries = page.totalEntries;
        }
        return {
          convId: page.convId,
          btwSessionId: btw?.sessionId ?? null,
          olderCursor: page.hasOlder ? { beforeEntryIndex: page.startIndex, beforeBlockIndex: page.startBlockIndex } : null,
        };
      }
    }

    // Tool-result bodies are fetched separately only when the TUI expands them.
    const snapshotDiagnostics: Partial<convStore.RenderSnapshotDiagnostics> | undefined = metrics ? {} : undefined;
    const data = getRenderSnapshot(convId, snapshotDiagnostics);
    if (!data) return null;
    const compactStartedAt = metrics ? performance.now() : 0;
    const compactData = compactHistoryImages(data);
    const compactMs = metrics ? performance.now() - compactStartedAt : 0;
    const paginateStartedAt = metrics ? performance.now() : 0;
    const page = paginated ? pageDisplayHistory(compactData.entries, turns ?? INITIAL_HISTORY_TURNS, undefined, windowOptions) : null;
    const paginateMs = metrics ? performance.now() - paginateStartedAt : 0;
    const queued = convStore.getQueuedMessages(data.convId);
    const summary = convStore.getSummary(data.convId);
    const responseEntries = page ? [...page.pinnedEntries, ...page.entries] : compactData.entries;
    const sendStartedAt = metrics ? performance.now() : 0;
    const btw = btwManager.getSnapshot(data.convId);
    const responseBytes = server.sendTo(target, encodeHistoryDelta({
      type: "conversation_loaded",
      reqId,
      convId: compactData.convId,
      provider: compactData.provider,
      model: compactData.model,
      effort: compactData.effort,
      fastMode: compactData.fastMode,
      entries: responseEntries,
      ...(page ? {
        historyStartIndex: page.startIndex,
        ...(page.startBlockIndex > 0 ? { historyStartBlockIndex: page.startBlockIndex } : {}),
        historyStartUserIndex: page.startUserIndex,
        historyTotalEntries: page.totalEntries,
        hasOlderHistory: page.hasOlder,
        ...(initialBackfillReqId && page.hasOlder ? { initialBackfillReqId } : {}),
      } : {}),
      historyRev: convStore.getHistoryRev(compactData.convId),
      ...(compactData.pendingAI ? { pendingAI: compactData.pendingAI } : {}),
      contextTokens: compactData.contextTokens,
      toolOutputsIncluded: compactData.toolOutputsIncluded,
      queuedMessages: queued.length > 0 ? queued : undefined,
      goal: summary?.goal ?? null,
      btw,
    }, cachedEntryHashes), metrics !== undefined);
    if (metrics) {
      metrics.snapshot = snapshotDiagnostics ?? {};
      metrics.compactMs = compactMs;
      metrics.paginateMs = paginateMs;
      metrics.sendMs = performance.now() - sendStartedAt;
      metrics.responseBytes = typeof responseBytes === "number" ? responseBytes : 0;
      metrics.responseEntries = responseEntries.length;
      metrics.historyTotalEntries = page?.totalEntries ?? compactData.entries.length;
    }
    return {
      convId: data.convId,
      btwSessionId: btw?.sessionId ?? null,
      olderCursor: page?.hasOlder ? { beforeEntryIndex: page.startIndex, beforeBlockIndex: page.startBlockIndex } : null,
    };
  };

  const sendCompactConversationHistory = (
    target: ConnectedClient,
    convId: string,
    beforeEntryIndex: number,
    beforeBlockIndex: number,
    turns: number,
    reqId?: string,
    requestSource?: "initial-backfill" | "viewport",
    metrics?: ConversationLoadMetrics,
    cachedEntryHashes?: string[],
    folded = false,
  ): boolean => {
    const windowOptions: HistoryWindowOptions = { ...historyWindowOptions(target, convId, folded), beforeBlockIndex };
    {
      const snapshotDiagnostics: Partial<convStore.RenderSnapshotDiagnostics> | undefined = metrics ? {} : undefined;
      const page = convStore.getStoredDisplayPage(convId, turns, beforeEntryIndex, snapshotDiagnostics, windowOptions);
      if (page) {
        const sendStartedAt = metrics ? performance.now() : 0;
        const responseBytes = server.sendTo(target, encodeHistoryDelta({
          type: "conversation_history_loaded",
          reqId,
          convId,
          requestSource,
          entries: page.entries,
          historyStartIndex: page.startIndex,
          ...(page.startBlockIndex > 0 ? { historyStartBlockIndex: page.startBlockIndex } : {}),
          historyStartUserIndex: page.startUserIndex,
          historyEndIndex: page.endIndex,
          ...(page.endBlockIndex > 0 ? { historyEndBlockIndex: page.endBlockIndex } : {}),
          historyTotalEntries: page.totalEntries,
          hasOlderHistory: page.hasOlder,
          historyRev: convStore.getHistoryRev(convId),
        }, cachedEntryHashes), metrics !== undefined);
        if (metrics) {
          metrics.snapshot = snapshotDiagnostics ?? {};
          metrics.compactMs = 0;
          metrics.paginateMs = 0;
          metrics.sendMs = performance.now() - sendStartedAt;
          metrics.responseBytes = typeof responseBytes === "number" ? responseBytes : 0;
          metrics.responseEntries = page.entries.length;
          metrics.historyTotalEntries = page.totalEntries;
        }
        return true;
      }
    }

    const snapshotDiagnostics: Partial<convStore.RenderSnapshotDiagnostics> | undefined = metrics ? {} : undefined;
    const data = getRenderSnapshot(convId, snapshotDiagnostics);
    if (!data) return false;
    const compactStartedAt = metrics ? performance.now() : 0;
    const compactData = compactHistoryImages(data);
    const compactMs = metrics ? performance.now() - compactStartedAt : 0;
    const paginateStartedAt = metrics ? performance.now() : 0;
    const page = pageDisplayHistory(compactData.entries, turns, beforeEntryIndex, windowOptions);
    const paginateMs = metrics ? performance.now() - paginateStartedAt : 0;
    const sendStartedAt = metrics ? performance.now() : 0;
    const responseBytes = server.sendTo(target, encodeHistoryDelta({
      type: "conversation_history_loaded",
      reqId,
      convId,
      requestSource,
      entries: page.entries,
      historyStartIndex: page.startIndex,
      ...(page.startBlockIndex > 0 ? { historyStartBlockIndex: page.startBlockIndex } : {}),
      historyStartUserIndex: page.startUserIndex,
      historyEndIndex: page.endIndex,
      ...(page.endBlockIndex > 0 ? { historyEndBlockIndex: page.endBlockIndex } : {}),
      historyTotalEntries: page.totalEntries,
      hasOlderHistory: page.hasOlder,
      historyRev: convStore.getHistoryRev(convId),
    }, cachedEntryHashes), metrics !== undefined);
    if (metrics) {
      metrics.snapshot = snapshotDiagnostics ?? {};
      metrics.compactMs = compactMs;
      metrics.paginateMs = paginateMs;
      metrics.sendMs = performance.now() - sendStartedAt;
      metrics.responseBytes = typeof responseBytes === "number" ? responseBytes : 0;
      metrics.responseEntries = page.entries.length;
      metrics.historyTotalEntries = page.totalEntries;
    }
    return true;
  };

  const sendGoalUpdated = (convId: string, reqId: string | undefined, message?: string) => {
    const goal = convStore.getIndexedSummary(convId)?.goal ?? null;
    server.sendToSubscribers(convId, { type: "goal_updated", reqId, convId, goal, message });
    broadcastConversationUpdated(server, convId);
    return goal;
  };

  const broadcastSidebarUndoResult = (
    target: ConnectedClient,
    reqId: string | undefined,
    result: convStore.UndoDeleteResult | convStore.AsyncUndoDeleteResult | null,
    emptyMessage: string,
    previousSidebarState: SidebarStateSnapshot,
  ): void => {
    if (result?.type === "conversation") {
      const summary = convStore.getSummary(result.conversation.id);
      if (summary) {
        server.broadcast({ type: "conversation_restored", reqId, summary });
        broadcastSidebarStatePatch(previousSidebarState);
        return;
      }
    } else if (result?.type === "conversations") {
      for (const conv of result.conversations) {
        const summary = convStore.getSummary(conv.id);
        if (summary) server.broadcast({ type: "conversation_restored", reqId, summary });
      }
      broadcastSidebarStatePatch(previousSidebarState);
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
      broadcastSidebarStatePatch(previousSidebarState);
      return;
    }

    server.sendTo(target, { type: "error", reqId, message: emptyMessage });
  };

  const isSafeClientConversationId = (id: string): boolean => /^\d+-[a-z0-9]{6}$/.test(id);

  // ── Daemon-owned queue scheduler ──────────────────────────────────

  let queuePumpTimer: ReturnType<typeof setTimeout> | null = null;
  let queuePumpAt = 0;
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
  /** Re-check timed entries at least this often so wall-clock jumps (suspend/resume) cannot strand them. */
  const QUEUE_DELAY_MAX_TIMER_MS = 60_000;

  const scheduleQueuePump = (delayMs = 120): void => {
    if (schedulerGeneration !== queueSchedulerGeneration || getDaemonShutdownMode()) return;
    const pumpAt = Date.now() + delayMs;
    if (queuePumpTimer) {
      // A long timed-queue wake must not hold back an earlier readiness pump.
      if (queuePumpAt <= pumpAt) return;
      clearTimeout(queuePumpTimer);
    }
    queuePumpAt = pumpAt;
    queuePumpTimer = setTimeout(() => {
      queuePumpTimer = null;
      if (schedulerGeneration !== queueSchedulerGeneration) return;
      pumpQueuedMessages();
    }, delayMs);
  };

  /** Due time of a timed `/queue <duration>` entry, or null for idle-wait and stream entries. */
  const queueDelayDueAt = (entry: import("./message-queue").QueuedMessage): number | null => (
    entry.source === "global-idle" && entry.waitTarget?.type === "delay"
      ? entry.createdAt + entry.waitTarget.delayMs
      : null
  );

  const queueWaitStatus = (entry: import("./message-queue").QueuedMessage): "ready" | "waiting" | "missing-target" => {
    const waitTarget = entry.waitTarget ?? { type: "global" as const };
    if (waitTarget.type === "delay") return Date.now() >= entry.createdAt + waitTarget.delayMs ? "ready" : "waiting";
    const sidebar = convStore.listSidebarState();
    const hasStreamQueue = (convId: string) => convStore.isQueuedMessageDeliverySuspended(convId)
      || convStore.getQueuedMessages(convId).length > 0;
    // A Claude Code turn sleeping inside a long chrono call is as idle as a
    // suspended one, which no longer streams.
    const isWorking = (conversation: (typeof sidebar.conversations)[number]) => conversation.streaming
      && inlineLongSleepStartedAt(conversation) === null;

    if (waitTarget.type === "global") {
      if (sidebar.conversations.some(isWorking)) return "waiting";
      if (convStore.listInternalQueuedMessages().some(message => message.source === "daemon")) return "waiting";
      return "ready";
    }
    if (waitTarget.type === "conversation") {
      const conversation = sidebar.conversations.find(candidate => candidate.id === waitTarget.convId);
      if (!conversation) return "missing-target";
      return isWorking(conversation) || hasStreamQueue(conversation.id) ? "waiting" : "ready";
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
      && (isWorking(conversation) || hasStreamQueue(conversation.id))) ? "waiting" : "ready";
  };

  type DurableQueueEntry = import("./message-queue").QueuedMessage;
  interface QueuedCommandDefinition {
    validate(text: string): string | null;
    execute(entry: DurableQueueEntry): Promise<AssistantTurnOutcome>;
  }

  const noArgumentQueuedCommand = (name: string) => (text: string): string | null => (
    text.trim() === name ? null : `Usage: ${name}`
  );

  const queuedCommandDefinitions = new Map<string, QueuedCommandDefinition>([
    ["/replay", {
      validate: noArgumentQueuedCommand("/replay"),
      execute: async (entry) => {
        const pending = listPendingSubagentNotifications({ childConvId: entry.convId, state: "running" })[0];
        const outcome = pending && !hasSubagentTaskStarted(pending)
          ? await orchestrateSendMessage(
              server,
              null,
              undefined,
              entry.convId,
              pending.task,
              pending.childStartedAt,
              buildOrchestrationCallbacks(entry.convId),
              undefined,
              {
                subagentMaxDepth: pending.subagentMaxDepth,
                queueEntryId: entry.id,
                automation: { kind: "exo_send", sourceId: pending.parentConvId },
              },
            )
          : await orchestrateReplayConversation(
              server,
              null,
              undefined,
              entry.convId,
              Date.now(),
              buildOrchestrationCallbacks(entry.convId),
              {
                ...(entry.subagentMaxDepth !== undefined ? { subagentMaxDepth: entry.subagentMaxDepth } : {}),
                queueEntryId: entry.id,
              },
            );
        notificationRuntime.complete(entry.convId, outcome);
        return outcome;
      },
    }],
    ["/compact", {
      validate: noArgumentQueuedCommand("/compact"),
      execute: async (entry) => await orchestrateCompactConversation(
        server,
        null,
        undefined,
        entry.convId,
        Date.now(),
        buildOrchestrationCallbacks(entry.convId),
        { queueEntryId: entry.id },
      ),
    }],
  ]);

  const dispatchQueuedMessage = async (entry: DurableQueueEntry): Promise<void> => {
    if (dispatchingQueueIds.has(entry.id) || dispatchingConversationIds.has(entry.convId)) return;
    if (convStore.isQueuedMessageDeliverySuspended(entry.convId)) return;
    if ((queueRetryAfter.get(entry.id) ?? 0) > Date.now()) return;
    dispatchingQueueIds.add(entry.id);
    dispatchingConversationIds.add(entry.convId);
    const holdsIdleFifo = entry.source === "global-idle" && queueDelayDueAt(entry) === null;
    if (holdsIdleFifo) globalIdleDispatchInFlight = true;
    try {
      const queuedCommand = entry.command && entry.source === "global-idle"
        && entry.target !== "new-conversation" && !entry.images?.length
        ? queuedCommandDefinitions.get(entry.command.name)
        : undefined;
      if (entry.command && !queuedCommand) {
        convStore.removeQueuedMessageById(entry.id);
        server.broadcast({
          type: "queue_notice",
          queueId: entry.id,
          convId: entry.convId,
          message: `Queued command is invalid or no longer supported: ${entry.command.name}`,
          level: "error",
        });
        return;
      }

      const outcome = queuedCommand
        ? await queuedCommand.execute(entry)
        : await orchestrateSendMessage(
          server,
          null,
          undefined,
          entry.convId,
          entry.text,
          Date.now(),
          buildOrchestrationCallbacks(entry.convId),
          entry.images,
          {
            ...(entry.subagentMaxDepth !== undefined ? { subagentMaxDepth: entry.subagentMaxDepth } : {}),
            subagentNotificationId: entry.subagentNotificationId,
            queueEntryId: entry.id,
            automation: entry.automation,
          },
        );
      // Preflight failures happen before orchestration accepts/removes
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
            message: `Queued ${entry.command?.name ?? "send"} failed: ${error}`,
            level: "error",
          });
        }
      }
    } catch (err) {
      log("error", `handler: queued turn failed for ${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
      if (convStore.getQueuedMessageById(entry.id)) queueRetryAfter.set(entry.id, Date.now() + 5_000);
    } finally {
      dispatchingQueueIds.delete(entry.id);
      dispatchingConversationIds.delete(entry.convId);
      if (holdsIdleFifo) globalIdleDispatchInFlight = false;
      scheduleQueuePump();
    }
  };

  /** Recreate a queued draft conversation if the daemon died between enqueue and creation. */
  const recoverQueuedDraftConversation = (entry: DurableQueueEntry): void => {
    if (entry.target !== "new-conversation"
        || convStore.hasConversation(entry.convId)
        || convStore.hasDeletedConversation(entry.convId)) return;
    const defaults = effectiveConversationDefaults();
    const provider = entry.provider ?? defaults.provider;
    if (!getProvider(provider)) return;
    const model = entry.model && (isKnownModel(provider, entry.model) || allowsCustomModels(provider))
      ? entry.model
      : (provider === defaults.provider ? defaults.model : getDefaultModel(provider));
    const effort = normalizeEffort(provider, model, entry.effort);
    const requestedFastMode = entry.fastMode ?? false;
    const fastMode = supportsFastMode(provider, model, requestedFastMode) ? requestedFastMode : false;
    const folderId = entry.folderId
      && convStore.listSidebarState().folders.some(folder => folder.id === entry.folderId)
      ? entry.folderId
      : null;
    convStore.create(entry.convId, provider, model, PENDING_TITLE, effort, fastMode, folderId);
    broadcastConversationUpdated(server, entry.convId);
    startTitleGeneration(server, entry.convId, { extraContext: entry.text });
    log("info", `handler: recovered queued draft conversation ${entry.convId} from durable queue ${entry.id}`);
  };

  let queueDeliveryReady = !options.holdQueueDeliveryUntilReady;
  let preparedRestartTimer: ReturnType<typeof setTimeout> | null = null;
  const pumpQueuedMessages = (): void => {
    if (getDaemonShutdownMode() || !queueDeliveryReady) return;
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
      if (!convStore.hasConversation(entry.convId)) {
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

    const sleepsInline = (entry: DurableQueueEntry): boolean => {
      if (entry.command || entry.target === "new-conversation" || convStore.isQueuedMessageDeliverySuspended(entry.convId)) return false;
      const summary = convStore.getSummary(entry.convId);
      return !!summary && inlineLongSleepStartedAt(summary) !== null;
    };

    const pumpIdleWaitEntry = (entry: DurableQueueEntry): void => {
      const status = queueWaitStatus(entry);
      if (status === "missing-target" || !convStore.hasConversation(entry.convId)) {
        convStore.removeQueuedMessageById(entry.id);
        server.broadcast({
          type: "queue_notice",
          queueId: entry.id,
          convId: entry.convId,
          message: status === "missing-target"
            ? "Dropped queued message because its wait target no longer exists."
            : "Dropped queued message because its conversation no longer exists.",
          level: "error",
        });
      } else if (status === "ready"
          && !convStore.isStreaming(entry.convId)
          && !convStore.isQueuedMessageDeliverySuspended(entry.convId)) {
        if (!retryIsDeferred(entry.id)) void dispatchQueuedMessage(entry);
      } else if (status === "ready" && sleepsInline(entry)
          && convStore.steerGlobalIdleQueuedMessage(entry.id)) {
        // A turn sleeping inside a long chrono call takes the message now, as
        // a suspended one would by starting a turn for it.
        convStore.steerActiveTurn(entry.convId);
      } else {
        needsReadinessPoll = true;
      }
    };

    // `/queue` intentionally remains one global FIFO. Its first entry blocks
    // later idle-wait entries until its dependency is ready and its turn ends.
    const idleEntry = queued.find(entry => entry.source === "global-idle" && queueDelayDueAt(entry) === null);
    if (idleEntry && !globalIdleDispatchInFlight && !dispatchingQueueIds.has(idleEntry.id)) {
      recoverQueuedDraftConversation(idleEntry);
      pumpIdleWaitEntry(idleEntry);
    }

    // Timed `/queue <duration>` entries run on their own clocks outside that
    // FIFO: once due, each waits only for its own conversation to be idle.
    let earliestDueAt = Number.POSITIVE_INFINITY;
    for (const entry of queued) {
      const dueAt = queueDelayDueAt(entry);
      if (dueAt === null || dispatchingQueueIds.has(entry.id)) continue;
      recoverQueuedDraftConversation(entry);
      if (dueAt > now) earliestDueAt = Math.min(earliestDueAt, dueAt);
      else pumpIdleWaitEntry(entry);
    }

    const nextWakeAt = Math.min(earliestRetryAt, earliestDueAt);
    if (needsReadinessPoll) scheduleQueuePump();
    else if (Number.isFinite(nextWakeAt)) {
      scheduleQueuePump(Math.min(QUEUE_DELAY_MAX_TIMER_MS, Math.max(120, nextWakeAt - Date.now())));
    }
  };

  // One monitor per daemon: every client sees the same online/offline state.
  const unsubscribeConnectivity = connectivity.subscribe((snapshot) => {
    server.broadcast({ type: "connectivity_status", ...snapshot });
  });

  convStore.setQueuedMessagesChangedListener((messages) => {
    server.broadcast({ type: "queue_updated", messages: messages.filter(message => !isHiddenConversation(message.convId)) });
    // Automated and message-end input waits for a boundary, but would end a
    // suspended chrono sleep; let a turn sleeping inside a chrono call decide.
    const queuedConvIds = new Set(messages
      .filter(message => message.source === "daemon")
      .map(message => message.convId));
    for (const convId of queuedConvIds) {
      if (convStore.getActiveBackgroundableToolName(convId) === "chrono") convStore.steerActiveTurn(convId);
    }
    scheduleQueuePump();
  });

  // Only commands which actually need live canonical state warm the runtime
  // window. Read-only paging, Stop, scheduling and turn admission stay cheap.
  const warmCommands = new Set([
    "btw_query", "btw_followup", "set_goal", "set_model", "set_effort",
    "set_fast_mode", "get_system_prompt", "load_instructions", "load_tool_instructions",
    "save_tool_instructions",
  ]);
  // Commands for one conversation take effect in arrival order. An inline
  // `/model` arrives as set_model … send_message in one burst; without this the
  // warm-up let the turn be admitted first, under the old model. A command
  // waits only behind an earlier one that is still warming.
  const startingConversationCommands = new Map<string, Promise<void>>();
  const handleCommand = async function handleCommand(client: ConnectedClient, cmd: Command): Promise<void> {
    // An app client reconnecting while the daemon starts waits until replays have started (app-api.ts).
    if (holdAppCommandUntilReady(client, cmd.type, () => { void handleCommand(client, cmd); })) return;
    const convId = "convId" in cmd && typeof cmd.convId === "string" ? cmd.convId : null;
    // Any command on a temporary app conversation keeps it from expiring.
    if (convId !== null && isAppConversation(convId)) touchAppConversation(convId);
    const earlier = convId === null ? undefined : startingConversationCommands.get(convId);
    const warms = warmCommands.has(cmd.type) || cmd.type === "trim_conversation" || cmd.type === "set_system_instructions";
    let markStarted: (() => void) | undefined;
    if (convId !== null && (earlier || warms)) {
      const started = new Promise<void>(resolve => { markStarted = resolve; });
      startingConversationCommands.set(convId, started);
      void started.then(() => {
        if (startingConversationCommands.get(convId) === started) startingConversationCommands.delete(convId);
      });
    }
    try {
      if (earlier) await earlier;
      if (warmCommands.has(cmd.type) && convId !== null) {
        await convStore.getAsync(convId);
      }
      if (cmd.type === "trim_conversation" || cmd.type === "set_system_instructions") {
        if (convStore.isStreaming(cmd.convId)) {
          if (cmd.type === "trim_conversation") {
            server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: "Cannot rewrite conversation history while it is streaming." });
            return;
          }
          // Instructions saved mid-turn wait for the turn to end (setSystemInstructions).
        } else {
          try {
            await convStore.getFullAsync(cmd.convId);
          } catch (error) {
            // A turn started meanwhile: the instructions wait for it instead.
            if (cmd.type === "trim_conversation" || !convStore.isStreaming(cmd.convId)) throw error;
          }
        }
      }
    } catch (error) {
      server.sendTo(client, {
        type: "error", reqId: "reqId" in cmd ? cmd.reqId : undefined,
        ...("convId" in cmd && typeof cmd.convId === "string" ? { convId: cmd.convId } : {}),
        message: `Could not load verified conversation: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    } finally {
      // Waiters resume in a microtask, after this command's synchronous body.
      markStarted?.();
    }
    try { switch (cmd.type) {

      // ── Connection/bootstrap commands ──────────────────────────────

      case "set_conversation_defaults":
      case "reset_conversation_defaults": {
        let snapshot: ReturnType<typeof conversationDefaultsSnapshot>;
        try {
          if (cmd.reqId !== undefined && typeof cmd.reqId !== "string") {
            throw new Error("Invalid conversation defaults request id");
          }
          snapshot = cmd.type === "set_conversation_defaults"
            ? setDaemonConversationDefaults(cmd.defaults)
            : resetDaemonConversationDefaults();
        } catch (error) {
          server.sendTo(client, {
            type: "error",
            reqId: typeof cmd.reqId === "string" ? cmd.reqId : undefined,
            message: error instanceof Error ? error.message : String(error),
          });
          break;
        }
        server.broadcast({ type: "conversation_defaults", ...snapshot });
        server.sendTo(client, {
          type: "conversation_defaults",
          reqId: cmd.reqId,
          ...snapshot,
          message: cmd.type === "set_conversation_defaults"
            ? "Default model saved"
            : "Default model reset to app default",
        });
        break;
      }

      case "save_user_macro":
      case "delete_user_macro": {
        const reqId = typeof cmd.reqId === "string" ? cmd.reqId : undefined;
        let result: { macro: UserMacro; macros: UserMacro[]; action: "created" | "updated" | "deleted" };
        try {
          if (cmd.type === "save_user_macro") {
            const saved = saveUserMacro(cmd.macro, { create: cmd.create === true });
            result = { ...saved, action: saved.replaced ? "updated" : "created" };
          } else {
            result = { ...deleteUserMacro(cmd.name), action: "deleted" };
          }
        } catch (error) {
          server.sendTo(client, { type: "error", reqId, message: error instanceof Error ? error.message : String(error) });
          break;
        }
        server.broadcast({ type: "user_macros", macros: result.macros });
        server.sendTo(client, {
          type: "user_macros", reqId, macros: result.macros,
          change: { action: result.action, macro: result.macro },
        });
        break;
      }

      case "ping": {
        // App clients get no bootstrap (docs/app-api.md).
        if (client.app) {
          server.sendTo(client, { type: "pong", reqId: cmd.reqId });
          break;
        }
        if (cmd.updateStatusOnly) {
          server.sendTo(client, { type: "pong", reqId: cmd.reqId, updateStatus: await getDaemonUpdateStatus() });
          break;
        }
        server.sendTo(client, { type: "pong", reqId: cmd.reqId });
        // An incremental first page is small and drawn together with the
        // conversation, so it leads; a whole list stays behind the small events.
        const [conversationsList, restOfList] = bootstrapConversationsLists(client);
        if (restOfList) server.sendTo(client, conversationsList!);
        const externalStyles = getExternalToolStyles();
        server.sendTo(client, {
          type: "tools_available",
          macroEnvironment: localMacroEnvironment(),
          conversationDefaults: conversationDefaultsSnapshot(),
      experimental: experimentalFeatures(),
          providers: getProviders(),
          tools: getToolDisplayInfo(),
          authByProvider: getAuthByProvider(),
          authInfoByProvider: getAuthInfoByProvider(),
          ...(externalStyles.length > 0 ? { externalToolStyles: externalStyles } : {}),
          providerProxies: providerProxies.list(),
        });
        server.sendTo(client, { type: "user_macros", macros: listUserMacros() });
        for (const provider of getProviders()) {
          const lastUsage = getLastUsage(provider.id);
          server.sendTo(client, { type: "usage_update", provider: provider.id, usage: lastUsage });
        }
        // Small first-screen state goes ahead of the large sidebar list. A
        // status still being worked out right after startup is pushed when known.
        const updateStatus = client.capabilities?.has("update-status-push") ? peekDaemonUpdateStatus() : null;
        if (updateStatus) server.sendTo(client, { type: "update_status", status: updateStatus });
        // The sidebar is the startup-critical payload. Token statistics can be
        // large and are independent, so never put them ahead of first paint.
        if (!restOfList) server.sendTo(client, conversationsList!);
        if (!client.capabilities?.has("token-stats-on-demand")) {
          server.sendTo(client, { type: "token_stats", stats: getTokenStatsSnapshot() });
        }
        server.sendTo(client, { type: "queue_updated", messages: visibleQueuedMessages() });
        server.sendTo(client, { type: "connectivity_status", ...connectivity.snapshot() });
        if (restOfList) server.sendTo(client, restOfList);
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

      case "get_history_revisions": {
        if (!Array.isArray(cmd.convIds) || cmd.convIds.length > MAX_HISTORY_REVISION_IDS
            || cmd.convIds.some(id => typeof id !== "string")) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: "Invalid history revisions request" });
          break;
        }
        server.sendTo(client, { type: "history_revisions", reqId: cmd.reqId, revs: visibleHistoryRevs(cmd.convIds) });
        break;
      }

      case "get_token_stats": {
        server.sendTo(client, { type: "token_stats", reqId: cmd.reqId, stats: getTokenStatsSnapshot() });
        break;
      }

      case "list_path_directory": {
        const listings = await listPathDirectoryWithLookahead(cmd.directory, cmd.prefix);
        server.sendTo(client, {
          type: "path_directory_entries",
          reqId: cmd.reqId,
          listings,
        });
        break;
      }

      case "resolve_file_link": {
        const reqId = typeof cmd.reqId === "string" ? cmd.reqId : undefined;
        const convId = typeof cmd.convId === "string" ? cmd.convId : undefined;
        if (!reqId || !convId || typeof cmd.target !== "string") {
          server.sendTo(client, {
            type: "error",
            reqId,
            convId,
            message: "Invalid resolve_file_link command",
          });
          break;
        }
        if (!convStore.hasConversation(cmd.convId)) {
          server.sendTo(client, {
            type: "error",
            reqId: cmd.reqId,
            convId: cmd.convId,
            message: `Conversation ${cmd.convId} not found`,
          });
          break;
        }
        try {
          const resolved = await resolveFileLink(cmd.convId, cmd.target);
          server.sendTo(client, {
            type: "file_link_resolved",
            reqId: cmd.reqId,
            convId: cmd.convId,
            ...resolved,
          });
        } catch (error) {
          server.sendTo(client, {
            type: "error",
            reqId: cmd.reqId,
            convId: cmd.convId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        break;
      }

      case "consume_usage_reset": {
        const provider = cmd.provider ?? "openai";
        if (provider !== "openai") {
          server.sendTo(client, {
            type: "error",
            reqId: cmd.reqId,
            message: `Usage resets are not supported for ${provider}.`,
          });
          break;
        }
        if (openAIAccountMutationInFlight) {
          server.sendTo(client, {
            type: "error",
            reqId: cmd.reqId,
            message: "Cannot reset OpenAI usage while account authentication is still in progress.",
          });
          break;
        }
        if (openAIUsageResetInFlight) {
          server.sendTo(client, {
            type: "error",
            reqId: cmd.reqId,
            message: "An OpenAI usage reset is already in progress.",
          });
          break;
        }

        openAIUsageResetInFlight = true;
        server.sendTo(client, { type: "ack", reqId: cmd.reqId });
        void consumeUsageReset(provider).then((result) => {
          const usage = getLastUsage(provider);
          broadcastUsage(provider, usage);
          server.sendTo(client, {
            type: "usage_reset_result",
            reqId: cmd.reqId,
            provider,
            outcome: result.outcome,
            windowsReset: result.windowsReset,
            ...(result.remainingResets !== undefined ? { remainingResets: result.remainingResets } : {}),
          });
        }).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          log("error", `handler: OpenAI usage reset failed: ${message}`);
          server.sendTo(client, {
            type: "error",
            reqId: cmd.reqId,
            message: `OpenAI usage reset failed: ${message}`,
          });
        }).finally(() => {
          openAIUsageResetInFlight = false;
        });
        break;
      }

      case "prepare_shutdown": {
        const mode = beginDaemonShutdown(cmd.mode);
        log("info", `handler: service requested daemon shutdown mode=${mode}`);
        if (mode === "restart" && lifecycle.requestRestart && !preparedRestartTimer) {
          // Prepared, the daemon only winds down: no queue pump, no finalizer
          // continuations, every restart request refused. If its service never
          // restarts it (the caller died after preparing), finish the restart.
          preparedRestartTimer = setTimeout(() => {
            log("warn", "handler: prepared restart was never carried out; restarting now");
            lifecycle.requestRestart?.();
          }, lifecycle.preparedRestartTimeoutMs ?? PREPARE_RESTART_MAX_SETTLE_MS + 90_000);
          preparedRestartTimer.unref?.();
        }
        if (cmd.interruptForReplay && mode === "restart") {
          // One round trip instead of the control process polling and aborting
          // over the socket: settle in-process, then report what will replay.
          writeActiveGoalRestartMarker();
          const timeoutMs = typeof cmd.timeoutMs === "number" && Number.isFinite(cmd.timeoutMs)
            ? Math.min(Math.max(cmd.timeoutMs, 0), PREPARE_RESTART_MAX_SETTLE_MS)
            : PREPARE_RESTART_MAX_SETTLE_MS;
          const prepared = await prepareCatchableShutdownForReplay(timeoutMs);
          if (prepared.convIds.length > 0) log("info", `handler: interrupted for restart replay: ${prepared.convIds.join(", ")}`);
          server.sendTo(client, { type: "shutdown_prepared", reqId: cmd.reqId, convIds: prepared.convIds, stillStreaming: prepared.stillStreaming });
          break;
        }
        server.sendTo(client, { type: "ack", reqId: cmd.reqId });
        break;
      }

      case "restart_daemon": {
        if (!lifecycle.requestRestart) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: "This daemon instance cannot restart itself." });
          break;
        }
        beginDaemonShutdown("restart");
        server.sendTo(client, { type: "ack", reqId: cmd.reqId });
        log("info", "handler: connected client requested an instance-local daemon restart");
        // Let the acknowledgement enter the socket buffer before shutdown closes
        // every client. The owning service/exotest supervisor performs relaunch.
        setTimeout(() => lifecycle.requestRestart?.(), 0);
        break;
      }

      // ── Conversation lifecycle commands ───────────────────────────

      case "new_conversation": {
        let id = cmd.convId ?? convStore.generateId();
        while (!cmd.convId && (convStore.hasConversation(id) || convStore.hasDeletedConversation(id))) {
          id = convStore.generateId();
        }
        if (cmd.draftToolPolicyId !== undefined) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: id, message: "Tool selection is retired." });
          break;
        }
        if (cmd.convId && (!isSafeClientConversationId(cmd.convId)
            || convStore.hasConversation(cmd.convId)
            || convStore.hasDeletedConversation(cmd.convId))) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: "Invalid or duplicate client-supplied conversation id" });
          break;
        }
        // An app conversation (docs/app-api.md): validate its own fields first.
        let appSpec: AppCreateSpec | null;
        try {
          appSpec = parseAppCreate(cmd, client);
          if (appSpec) {
            const refused = (["subagent", "delegation", "goalObjective", "initialMessage", "folderId", "titleContext"] as const)
              .find(field => cmd[field] !== undefined && cmd[field] !== null && cmd[field] !== false);
            if (refused) throw new Error(`${refused} is not available for app conversations`);
          }
        } catch (error) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: id, message: error instanceof Error ? error.message : String(error) });
          break;
        }
        const conversationDefaults = effectiveConversationDefaults();
        let delegationSelection: ReturnType<typeof resolveDelegationModel> | undefined;
        if (cmd.subagent || cmd.delegation) {
          try { delegationSelection = resolveDelegationModel(cmd); }
          catch (error) {
            server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: id, message: error instanceof Error ? error.message : String(error) });
            break;
          }
        }
        const inferredProvider = inferProviderForModel(cmd.model);
        const provider = delegationSelection?.provider ?? cmd.provider ?? inferredProvider ?? conversationDefaults.provider;
        const requestedModel = delegationSelection?.model ?? cmd.model;
        const providerInfo = getProvider(provider);
        if (!providerInfo) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: id, message: `Unknown provider: ${provider}` });
          break;
        }
        if (requestedModel && !isKnownModel(provider, requestedModel) && !allowsCustomModels(provider)) {
          server.sendTo(client, {
            type: "error",
            reqId: cmd.reqId,
            convId: id,
            message: unknownModelMessage(provider, requestedModel),
          });
          break;
        }
        const model = requestedModel ?? (provider === conversationDefaults.provider ? conversationDefaults.model : getDefaultModel(provider));
        const daybreakError = daybreakSelectionError(provider, model);
        if (daybreakError) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: id, message: daybreakError });
          break;
        }
        const defaultEffort = provider === conversationDefaults.provider && model === conversationDefaults.model
          ? conversationDefaults.effort
          : undefined;
        const effort = delegationSelection?.effort ?? normalizeEffort(provider, model, cmd.effort ?? defaultEffort);
        const requestedFastMode = isFastMode(cmd.fastMode)
          ? cmd.fastMode
          : (delegationSelection?.fastMode ?? (provider === conversationDefaults.provider && model === conversationDefaults.model ? conversationDefaults.fastMode : false));
        if (cmd.fastMode !== undefined && (!isFastMode(cmd.fastMode) || (cmd.fastMode && !supportsFastMode(provider, model, cmd.fastMode)))) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: id, message: `Fast mode is only available for ${provider} conversations that support it.` });
          break;
        }
        const fastMode = supportsFastMode(provider, model, requestedFastMode) ? requestedFastMode : false;
        if (appSpec) {
          try { checkAppToolsForModel(appSpec, provider, model); } catch (error) {
            server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: id, message: error instanceof Error ? error.message : String(error) });
            break;
          }
        }
        const initialMessage = cmd.initialMessage;
        const goalObjective = cmd.goalObjective?.trim();
        if (goalObjective && cmd.goalMaxTimeMs !== undefined && (!Number.isSafeInteger(cmd.goalMaxTimeMs) || cmd.goalMaxTimeMs <= 0)) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: "Goal max time must be a positive number of milliseconds." });
          break;
        }
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
        const previousSubagentSidebarState = cmd.subagent || appSpec?.lifetime === "saved" ? convStore.listSidebarState() : null;
        const subagentFolder = cmd.subagent
          ? convStore.ensureTopLevelFolder(SUBAGENTS_FOLDER_NAME, { mutedOnCreate: true })
          : null;
        if (cmd.subagent && !subagentFolder) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Failed to create ${SUBAGENTS_FOLDER_NAME} folder` });
          break;
        }
        let appFolderId: string | null = null;
        if (appSpec) {
          try {
            if (appSpec.lifetime === "saved") appFolderId = ensureAppFolder(appSpec.app);
            registerAppCreate(id, appSpec);
          } catch (error) {
            server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: id, message: error instanceof Error ? error.message : String(error) });
            break;
          }
        }
        const folderId = subagentFolder?.id ?? appFolderId ?? cmd.folderId ?? null;
        // Its first message is told about the client machines (and which one
        // it was written on) and the goal (set just below) like any other.
        if (initialMessage) noteUserWroteFrom(client, id);
        const notices = initialMessage ? pendingTurnNotices({
          id,
          provider,
          messages: [],
          subagentPolicy: cmd.subagent ? { parentConversationId: null, allowEdits: false, parentSystemInstructions: "" } : null,
          goal: goalObjective ? { status: "active", objective: goalObjective } : null,
        }) : [];
        if (initialMessage) {
          convStore.createWithInitialUserMessage(
            id,
            provider,
            model,
            title,
            effort,
            fastMode,
            cmd.subagent
              ? { ...initialMessage, automation: { kind: "exo_send" } }
              : initialMessage,
            folderId,
            false,
            turnNoticeMessages(notices, model, initialMessage.startedAt),
          );
        } else if (appSpec) {
          try {
            convStore.create(id, provider, model, title?.trim().slice(0, 200), effort, fastMode, folderId);
          } catch (error) {
            abandonAppCreate(id);
            throw error;
          }
          setAppConversationOwner(id, client);
        } else {
          convStore.create(id, provider, model, title, effort, fastMode, folderId);
        }
        if (cmd.subagent) {
          convStore.setSubagentPolicy(id, {
            parentConversationId: null,
            allowEdits: false,
            parentSystemInstructions: "",
          });
        }
        const goalResult = goalObjective ? setConversationGoal(id, goalObjective, { maxTimeMs: cmd.goalMaxTimeMs }) : null;
        const goal = goalResult?.goal ?? null;
        if (goal) scheduleGoalTimeLimit(server, id);
        log("info", `handler: created conversation ${id} (provider=${provider}, model=${model}, fastMode=${fastMode}, ${appSpec ? `app=${appSpec.app}, lifetime=${appSpec.lifetime}` : `title="${title ?? ""}"`}, initialMessage=${Boolean(initialMessage)}, folderId=${folderId ?? "root"})`);

        const appRecord = appSpec ? getAppRecord(id) : undefined;
        server.sendTo(client, {
          type: "conversation_created",
          reqId: cmd.reqId,
          convId: id,
          provider,
          model,
          effort,
          fastMode,
          goal,
          ...(appRecord ? { app: appConversationInfo(appRecord) } : {}),
        });
        broadcastConversationUpdated(server, id);
        if (previousSubagentSidebarState) broadcastSidebarStatePatch(previousSubagentSidebarState);

        if (goalObjective && !initialMessage) {
          server.subscribe(client, id);
          server.sendToSubscribers(id, { type: "goal_updated", reqId: cmd.reqId, convId: id, goal, message: goalResult?.message ?? `Goal set: ${goalObjective}` });
          startTitleGeneration(server, id, { extraContext: goalObjective });
          void orchestrateGoalCycle(server, id, buildOrchestrationCallbacks(id)).catch((err) => {
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
        btwManager.sendSnapshot(client, cmd.convId);
        // Clear unread when a client views the conversation
        if (convStore.clearUnread(cmd.convId)) {
          broadcastConversationUpdated(server, cmd.convId);
        }
        server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
        break;
      }

      case "client_capabilities": {
        for (const capability of cmd.capabilities) {
          if (capability === "targeted-unwind"
              || capability === "sidebar-reorder-delta"
              || capability === "sidebar-state-patch"
              || capability === "history-block-pagination"
              || capability === "token-stats-on-demand"
              || capability === "sidebar-digest-sync"
              || capability === "update-status-push"
              || capability === "sidebar-incremental"
              || capability === "client-exec-alive"
              || capability === "history-folded-elision"
              || capability === "history-revisions") client.capabilities.add(capability);
        }
        if (client.capabilities.has("sidebar-digest-sync") && isSidebarDigest(cmd.sidebarDigest)) {
          client.sidebarDigest = cmd.sidebarDigest;
        }
        if (client.capabilities.has("sidebar-incremental") && isSidebarViewHint(cmd.sidebarView)) {
          client.sidebarView = cmd.sidebarView;
        }
        if (cmd.clientHost) {
          attachClientHost(client, cmd.clientHost, event => server.sendTo(client, event), {
            via: "tui",
            reportsAlive: client.capabilities.has("client-exec-alive"),
          });
        }
        if (cmd.app !== undefined) welcomeAppClient(client, cmd);
        break;
      }

      case "client_exec_result":
      case "provider_proxy_client_exec_result": {
        settleClientExec(client, cmd);
        break;
      }

      case "client_exec_alive":
      case "provider_proxy_client_exec_alive": {
        clientExecAlive(client, cmd.execIds);
        break;
      }

      // ── /proxy ─────────────────────────────────────────────────────

      case "provider_proxy": {
        const reply = (message?: string, error = false) => server.sendTo(client, {
          type: "provider_proxies", reqId: cmd.reqId, proxies: providerProxies.list(),
          ...(message ? { message } : {}), ...(error ? { error } : {}),
        });
        try {
          if (cmd.action === "status") reply();
          else if (cmd.action === "off") reply(providerProxies.off(String(cmd.provider ?? "")));
          else if (cmd.action === "set") reply(await providerProxies.set(String(cmd.provider ?? ""), String(cmd.alias ?? "")));
          else reply(`Unknown /proxy action: ${String(cmd.action)}`, true);
        } catch (error) {
          reply(error instanceof Error ? error.message : String(error), true);
        }
        break;
      }

      case "provider_proxy_hello":
        providerProxyEndpointFor(client, true)!.handle(cmd);
        // The linking daemon's machine: client_bash runs there over this link.
        if (cmd.clientHost) attachClientHost(client, cmd.clientHost, event => server.sendTo(client, event), { via: "daemon", reportsAlive: true });
        break;

      case "provider_proxy_open":
      case "provider_proxy_ws_send":
      case "provider_proxy_cancel":
      case "provider_proxy_status":
      case "provider_proxy_consume_reset":
      case "provider_proxy_accounts":
      case "provider_proxy_exec":
      case "provider_proxy_exec_cancel":
      case "provider_proxy_ping": {
        const endpoint = providerProxyEndpointFor(client, false);
        if (endpoint) {
          endpoint.handle(cmd as ProviderProxyLinkCommand);
          break;
        }
        const message = "Send provider_proxy_hello first.";
        if (cmd.type === "provider_proxy_open") server.sendTo(client, { type: "provider_proxy_end", streamId: cmd.streamId, error: message });
        else if (cmd.type === "provider_proxy_exec") server.sendTo(client, { type: "provider_proxy_exec_result", execId: cmd.execId, output: "", byteTruncated: false, exitCode: null, signal: null, timedOut: false, error: message });
        else server.sendTo(client, { type: "error", reqId: "reqId" in cmd ? cmd.reqId : undefined, message });
        break;
      }
      case "unsubscribe": {
        server.unsubscribe(client, cmd.convId);
        server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
        break;
      }

      case "abort": {
        const ac = convStore.getActiveJob(cmd.convId);
        const activeStartedAt = convStore.getStreamingStartedAt(cmd.convId);
        const targetsActiveStream = cmd.expectedStartedAt === undefined
          || cmd.expectedStartedAt === activeStartedAt
          || (!ac && convStore.isStreamHandoffActive(cmd.convId));
        if (targetsActiveStream && cmd.reason !== "daemon-restart") {
          // Cancel admission immediately, even while a cold worker read is in
          // flight. Never wait for archive loading before acknowledging Stop.
          if (!ac) convStore.clearStreamHandoff(cmd.convId);
          const conv = convStore.getCached(cmd.convId);
          if ((conv?.goal ?? convStore.getIndexedSummary(cmd.convId)?.goal)?.status === "active") {
            if (conv) applyUserGoalAction(conv, "pause");
            else convStore.updateGoalStatus(cmd.convId, "paused", { reason: "Paused by user." });
            convStore.clearGoalContinuationAfterStream(cmd.convId);
            convStore.clearStreamHandoff(cmd.convId);
            cancelSuspendedTurn(server, cmd.convId);
            sendGoalUpdated(cmd.convId, cmd.reqId, "Goal paused. Use /goal resume to continue.");
          }
        }
        if (ac && targetsActiveStream) {
          ac.abort(cmd.reason === "daemon-restart" ? "daemon-restart" : undefined);
          log("info", `handler: abort requested for ${cmd.convId}${cmd.reason ? ` (${cmd.reason})` : ""}`);
        } else if (ac && !targetsActiveStream) {
          log("info", `handler: ignored stale abort for ${cmd.convId} (expected stream ${cmd.expectedStartedAt}, active stream ${activeStartedAt})`);
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
        const summary = convStore.getSummary(cmd.convId);
        const draft = !summary && cmd.draft === true && typeof cmd.convId === "string" && cmd.convId.length <= 80
          && isSafeClientConversationId(cmd.convId) && !convStore.hasDeletedConversation(cmd.convId);
        if ((!summary && !draft) || (summary && summary.provider !== "openai") || convStore.isStreaming(cmd.convId)
            || openAIAccountMutationInFlight) {
          if (cmd.reqId) server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: "Conversation cannot be prewarmed now." });
          break;
        }
        void getProviderAdapter("openai").prewarmConversation?.(cmd.convId)
          .then(() => {
            if (cmd.reqId) server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
          })
          .catch((err) => {
            log("debug", `openai prewarm failed for ${cmd.convId}: ${err instanceof Error ? err.message : err}`);
            if (cmd.reqId) server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: "OpenAI prewarm failed; normal send can still connect." });
          });
        break;
      }

      case "btw_query": {
        if (isAppConversation(cmd.convId)) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: "BTW is not available in app conversations." });
          break;
        }
        btwManager.start(client, cmd);
        break;
      }

      case "btw_followup": {
        if (isAppConversation(cmd.convId)) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: "BTW is not available in app conversations." });
          break;
        }
        btwManager.followup(client, cmd);
        break;
      }

      case "btw_close": {
        const result = btwManager.close(client, cmd.convId, cmd.sessionId);
        if (result === "already_closed" && !cmd.sessionId) {
          server.sendTo(client, { type: "ack", reqId: cmd.reqId });
        }
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
          const result = setConversationGoal(cmd.convId, objective, { maxTimeMs: cmd.maxTimeMs });
          if (!result.ok) {
            server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: result.message });
            break;
          }
          scheduleGoalTimeLimit(server, cmd.convId);
          if (cancelDeferredChronoSleep(cmd.convId)) broadcastConversationHistoryUpdated(server, cmd.convId);
          const goal = sendGoalUpdated(cmd.convId, cmd.reqId, result.message);
          log("info", `handler: set goal for ${cmd.convId}: "${objective.slice(0, 80)}"`);
          if (goal?.status === "active" && convStore.isStreaming(cmd.convId)) {
            convStore.requestGoalContinuationAfterStream(cmd.convId);
          } else if (goal?.status === "active") {
            void orchestrateGoalCycle(server, cmd.convId, buildOrchestrationCallbacks(cmd.convId), { subagentMaxDepth: null }).catch((err) => {
              log("error", `handler: initial goal continuation failed for ${cmd.convId}: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
          break;
        }

        if (cmd.action === "resume") {
          const result = applyUserGoalAction(conv, "resume");
          if (result.ok) scheduleGoalTimeLimit(server, cmd.convId);
          const goal = sendGoalUpdated(cmd.convId, cmd.reqId, result.message);
          if (result.ok && goal?.status === "active" && !convStore.isStreaming(cmd.convId)) {
            void orchestrateGoalCycle(server, cmd.convId, buildOrchestrationCallbacks(cmd.convId), { subagentMaxDepth: null }).catch((err) => {
              log("error", `handler: resumed goal continuation failed for ${cmd.convId}: ${err instanceof Error ? err.message : String(err)}`);
            });
          } else if (result.ok && goal?.status === "active") {
            convStore.requestGoalContinuationAfterStream(cmd.convId);
            log("info", `handler: resumed goal for ${cmd.convId} while streaming; continuation will run after the active stream stops`);
          }
          break;
        }

        const hadGoal = !!conv.goal;
        const result = applyUserGoalAction(conv, cmd.action);
        if (cmd.action !== "show" && result.ok && hadGoal) {
          convStore.clearGoalContinuationAfterStream(cmd.convId);
          if (cmd.action === "pause") {
            convStore.clearStreamHandoff(cmd.convId);
            cancelSuspendedTurn(server, cmd.convId);
            convStore.getActiveJob(cmd.convId)?.abort("goal-state-changed");
          }
        }
        const goalEvent = { type: "goal_updated" as const, reqId: cmd.reqId, convId: cmd.convId, goal: result.goal, message: result.message };
        server.sendTo(client, goalEvent);
        if (cmd.action !== "show") server.sendToSubscribersExcept(cmd.convId, goalEvent, client);
        if (cmd.action !== "show") broadcastConversationUpdated(server, cmd.convId);

        break;
      }

      case "chrono": {
        if (!convStore.hasConversation(cmd.convId)) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
          break;
        }
        const outcome = runChronoCommand(cmd);
        server.sendTo(client, outcome.event ?? { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: outcome.error ?? "Chrono command failed." });
        if (cmd.action !== "list" && outcome.event) log("info", `handler: /chrono ${cmd.action} for ${cmd.convId}`);
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

      // ── External notification routing ─────────────────────────────

      case "register_external_notification_source": {
        try {
          const source = registerExternalNotificationSource({ toolName: cmd.toolName, ...cmd.source });
          server.sendTo(client, { type: "external_notification_source", reqId: cmd.reqId, source });
        } catch (err) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: err instanceof Error ? err.message : String(err) });
        }
        break;
      }

      case "list_external_notification_sources": {
        server.sendTo(client, {
          type: "external_notification_sources",
          reqId: cmd.reqId,
          sources: listExternalNotificationSources(cmd.toolName),
        });
        break;
      }

      case "list_external_notification_subscriptions": {
        server.sendTo(client, {
          type: "external_notification_subscriptions",
          reqId: cmd.reqId,
          subscriptions: listExternalNotificationSubscriptions({
            toolName: cmd.toolName,
            sourceId: cmd.sourceId,
            convId: cmd.convId,
          }),
        });
        break;
      }

      case "subscribe_external_notification": {
        try {
          if (!convStore.getSummary(cmd.convId)) throw new Error(`Conversation ${cmd.convId} not found`);
          const subscription = subscribeExternalNotification({
            toolName: cmd.toolName,
            sourceId: cmd.sourceId,
            sourceLabel: cmd.sourceLabel,
            sourceDescription: cmd.sourceDescription,
            name: cmd.name,
            convId: cmd.convId,
            delivery: cmd.delivery,
            softWake: cmd.softWake,
          });
          server.sendTo(client, { type: "external_notification_subscription", reqId: cmd.reqId, subscription });
        } catch (err) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: err instanceof Error ? err.message : String(err) });
        }
        break;
      }

      case "unsubscribe_external_notification": {
        try {
          const removed = unsubscribeExternalNotification({
            subscriptionId: cmd.subscriptionId,
            toolName: cmd.toolName,
            sourceId: cmd.sourceId,
            convId: cmd.convId,
          });
          server.sendTo(client, {
            type: "external_notification_subscriptions",
            reqId: cmd.reqId,
            removed,
            subscriptions: listExternalNotificationSubscriptions({
              toolName: cmd.toolName,
              sourceId: cmd.sourceId,
              convId: cmd.convId,
            }),
          });
        } catch (err) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: err instanceof Error ? err.message : String(err) });
        }
        break;
      }

      case "update_external_notification_subscription": {
        try {
          const subscription = updateExternalNotificationSubscription(cmd.subscriptionId, {
            delivery: cmd.delivery,
            softWake: cmd.softWake,
            enabled: cmd.enabled,
            name: cmd.name,
          });
          server.sendTo(client, { type: "external_notification_subscription", reqId: cmd.reqId, subscription });
        } catch (err) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: err instanceof Error ? err.message : String(err) });
        }
        break;
      }

      case "publish_external_notification": {
        const deliveries: import("./protocol").ExternalNotificationPublishDelivery[] = [];
        const eventId = cmd.eventId?.trim();
        const text = cmd.text?.trim();
        if (!eventId || eventId.length > 300 || /[\r\n\0]/.test(eventId)) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: "Invalid external notification eventId" });
          break;
        }
        if (!text || text.length > 100_000) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: "External notification text must contain 1-100000 characters" });
          break;
        }
        if (cmd.data !== undefined) {
          let serializedData: string;
          try {
            serializedData = JSON.stringify(cmd.data);
          } catch {
            server.sendTo(client, { type: "error", reqId: cmd.reqId, message: "External notification data must be JSON-serializable" });
            break;
          }
          if (serializedData.length > 100_000) {
            server.sendTo(client, { type: "error", reqId: cmd.reqId, message: "External notification data must contain no more than 100000 characters" });
            break;
          }
        }

        for (const subscription of listExternalNotificationSubscriptions({ toolName: cmd.toolName, sourceId: cmd.sourceId })) {
          if (!subscription.enabled) continue;
          if (hasExternalNotificationReceipt(subscription.id, eventId)) {
            deliveries.push({ subscriptionId: subscription.id, convId: subscription.convId, status: "duplicate" });
            continue;
          }
          if (!convStore.getSummary(subscription.convId)) {
            deliveries.push({ subscriptionId: subscription.id, convId: subscription.convId, status: "failed", message: "Conversation not found" });
            continue;
          }

          const envelope = buildExternalNotificationEnvelope(subscription, {
            eventId,
            text,
            occurredAt: cmd.occurredAt,
            ...(cmd.data !== undefined ? { data: cmd.data } : {}),
          });
          try {
            if (subscription.delivery === "soft") {
              const queued = enqueueExternalNotificationSoftWake(subscription, {
                eventId,
                text,
                ...(cmd.data !== undefined ? { data: cmd.data } : {}),
                ...(Number.isFinite(cmd.occurredAt) ? { occurredAt: cmd.occurredAt } : {}),
              });
              recordExternalNotificationReceipt(subscription.id, eventId);
              deliveries.push({
                subscriptionId: subscription.id,
                convId: subscription.convId,
                status: queued.duplicate ? "duplicate" : "queued",
              });
            } else if (subscription.delivery === "inbox") {
              await convStore.getAsync(subscription.convId);
              if (!convStore.appendExternalInboxNotification(subscription.convId, envelope, Date.now(), subscription.id)) {
                throw new Error("Conversation not found");
              }
              recordExternalNotificationReceipt(subscription.id, eventId);
              broadcastConversationHistoryUpdated(server, subscription.convId);
              broadcastConversationUpdated(server, subscription.convId);
              deliveries.push({ subscriptionId: subscription.id, convId: subscription.convId, status: "inbox" });
            } else {
              // A durable queue entry closes the crash window between accepting an
              // external event and starting its autonomous model turn. The normal
              // queue scheduler starts it immediately when idle or after the
              // conversation's active turn when busy.
              const queueId = `external:${subscription.id}:${eventId}`;
              convStore.pushQueuedMessage(
                subscription.convId,
                envelope,
                "next-turn",
                undefined,
                null,
                undefined,
                queueId,
                Date.now(),
                { kind: "external_notification", sourceId: subscription.id },
              );
              recordExternalNotificationReceipt(subscription.id, eventId);
              deliveries.push({ subscriptionId: subscription.id, convId: subscription.convId, status: "queued" });
            }
          } catch (err) {
            deliveries.push({
              subscriptionId: subscription.id,
              convId: subscription.convId,
              status: "failed",
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }

        server.sendTo(client, {
          type: "external_notification_publish_result",
          reqId: cmd.reqId,
          toolName: cmd.toolName,
          sourceId: cmd.sourceId,
          eventId,
          deliveries,
        });
        break;
      }

      // ── Assistant turn commands ───────────────────────────────────

      case "send_message": {
        // Written on one of the user's machines: the model is told which.
        noteUserWroteFrom(client, cmd.convId);
        // App clients may leave the prompt's time to the daemon's clock.
        if (typeof cmd.startedAt !== "number" || !Number.isFinite(cmd.startedAt)) cmd.startedAt = Date.now();
        // An app client resending a prompt after a reconnect (same startedAt): wait for that turn, never run it twice.
        if (cmd.awaitResult === true && isAppConversation(cmd.convId)
            && convStore.hasMessageMetadata(cmd.convId, { startedAt: cmd.startedAt }, "user")) {
          const turnId = String(cmd.startedAt);
          const last = getAppRecord(cmd.convId)?.lastTurnResult;
          if (last?.turnId === turnId) server.sendTo(client, { ...last, ...(cmd.reqId ? { reqId: cmd.reqId } : {}) });
          else if (convStore.isStreaming(cmd.convId)) registerTurnAwait(client, cmd.reqId, cmd.convId, turnId);
          else server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: "That prompt was sent before and its turn's result is no longer known" });
          break;
        }
        // Ephemeral app conversations keep their images in memory only.
        if (!isEphemeralConversation(cmd.convId)) rememberSentImages(cmd.images);
        if (isAppConversation(cmd.convId)) {
          // App conversations get no generated title: the first line of their first prompt.
          const summary = convStore.getIndexedSummary(cmd.convId);
          if (summary && !summary.title.trim() && cmd.text.trim()) convStore.rename(cmd.convId, appTitleFromPrompt(cmd.text), false);
        }
        const awaited = cmd.awaitResult === true ? { client, reqId: cmd.reqId, convId: cmd.convId, turnId: String(cmd.startedAt) } : null;
        // Answered with turn_result when its turn ends (app-api.ts), unless refused before it starts.
        if (awaited) registerTurnAwait(client, awaited.reqId, awaited.convId, awaited.turnId);
        const dropAwait = (outcome?: AssistantTurnOutcome) => {
          if (awaited && !outcome?.suspended) dropTurnAwait(client, awaited.reqId, awaited.convId, awaited.turnId);
        };
        const target = convStore.getPolicyMetadata(cmd.convId);
        if (target && (cmd.delegation || target.subagentPolicy)) {
          try { assertDelegationModel(target.provider, target.model, cmd.legacy); }
          catch (error) {
            dropAwait();
            server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: error instanceof Error ? error.message : String(error) });
            break;
          }
        }
        if (target?.provider === "openai"
            && rejectDuringOpenAIAccountMutation(client, cmd.reqId, cmd.convId)) {
          dropAwait();
          break;
        }
        const callbacks = buildOrchestrationCallbacks(cmd.convId);
        if (cmd.detached) {
          if (cmd.notifyParent?.convId === cmd.convId) {
            dropAwait();
            server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: "Cannot notify the same conversation that is running the detached task." });
            break;
          }
          if (convStore.isStreaming(cmd.convId)) {
            dropAwait();
            server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: "Already streaming" });
            break;
          }
          const trackedParentId = cmd.notifyParent?.convId;
          // Detached sends to ordinary existing conversations are not child
          // subagent tasks. Conversations explicitly created as subagents retain
          // that classification when another turn is sent to them.
          const trackAsSubagent = Boolean(target?.subagentPolicy);
          if (cmd.notifyParent) {
            try {
              notificationRuntime.begin(cmd.notifyParent, cmd.convId, cmd.text, cmd.startedAt, null, trackAsSubagent);
            } catch (err) {
              dropAwait();
              server.sendTo(client, {
                type: "error",
                reqId: cmd.reqId,
                convId: cmd.convId,
                message: err instanceof Error ? err.message : String(err),
              });
              break;
            }
          }
          if (trackAsSubagent && trackedParentId && setSubagentActive(trackedParentId, cmd.convId, true, {
            title: convStore.subagentTaskTitle(cmd.convId) || "Subagent task",
            startedAt: cmd.startedAt,
          })) {
            broadcastConversationUpdated(server, trackedParentId);
          }
          const finishTrackedSubagent = () => {
            if (trackAsSubagent && trackedParentId && setSubagentActive(trackedParentId, cmd.convId, false)) {
              broadcastConversationUpdated(server, trackedParentId);
            }
          };
          server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
          const turn = orchestrateSendMessage(
            server, null, undefined, cmd.convId, cmd.text, cmd.startedAt, callbacks, cmd.images,
            {
              subagentMaxDepth: null,
              automation: cliDelegationAutomation({ ...cmd, delegation: true }, trackedParentId),
            },
          );
          maybeStartAutoTitleGeneration(cmd.convId);
          void turn.then((outcome) => {
            dropAwait(outcome);
            if (outcome.suspended || outcome.notificationsSettled) return;
            finishTrackedSubagent();
            if (cmd.notifyParent) notificationRuntime.complete(cmd.convId, outcome);
          }).catch((err) => {
            dropAwait();
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
        const automation = cliDelegationAutomation(cmd);
        const outcome = orchestrateSendMessage(
          server, client, cmd.reqId, cmd.convId, cmd.text, cmd.startedAt,
          callbacks,
          cmd.images,
          // The CLI waits for this reply itself; the parent gets no report too.
          automation ? { subagentMaxDepth: null, automation, replyAwaited: true } : { subagentMaxDepth: null },
        );
        maybeStartAutoTitleGeneration(cmd.convId);
        try {
          dropAwait(await outcome);
        } catch (error) {
          dropAwait();
          throw error;
        }
        break;
      }

      case "replay_conversation": {
        const target = convStore.getPolicyMetadata(cmd.convId);
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
              {
                subagentMaxDepth: pending.subagentMaxDepth,
                automation: { kind: "exo_send", sourceId: pending.parentConvId },
              },
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

      case "compact_conversation": {
        const target = convStore.getPolicyMetadata(cmd.convId);
        if (target?.provider === "openai"
            && rejectDuringOpenAIAccountMutation(client, cmd.reqId, cmd.convId)) break;
        await orchestrateCompactConversation(
          server,
          client,
          cmd.reqId,
          cmd.convId,
          cmd.startedAt,
          buildOrchestrationCallbacks(cmd.convId),
        );
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
        let requested: ReturnType<typeof parseRequestedModel>;
        try {
          requested = parseRequestedModel(cmd.provider, cmd.model);
          if (cmd.delegation) assertDelegationModel(requested.provider ?? conv.provider, requested.model!, cmd.legacy);
        } catch (error) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: error instanceof Error ? error.message : String(error) });
          break;
        }
        const nextProvider = requested.provider ?? conv.provider;
        const nextModel = requested.model!;
        const daybreakError = daybreakSelectionError(nextProvider, nextModel);
        if (daybreakError) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: daybreakError });
          break;
        }
        if (!getProvider(nextProvider)) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Unknown provider: ${nextProvider}` });
          break;
        }
        if (!isKnownModel(nextProvider, nextModel) && !allowsCustomModels(nextProvider)) {
          server.sendTo(client, {
            type: "error",
            reqId: cmd.reqId,
            convId: cmd.convId,
            message: unknownModelMessage(nextProvider, nextModel),
          });
          break;
        }
        const nextEffort = normalizeEffort(nextProvider, nextModel, conv.effort);
        const nextFastMode = supportsFastMode(nextProvider, nextModel, conv.fastMode) ? conv.fastMode : false;
        // Keep the checkpoint: native OpenAI compaction can cross models on
        // the same account. An incompatible/invalid checkpoint hard-fails on
        // the next turn instead of rebuilding the unbounded canonical archive.
        // Model selection itself never submits a provider request.
        const ok = convStore.setModel(cmd.convId, nextProvider, nextModel, nextEffort, nextFastMode);
        if (ok) {
          server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
          broadcastConversationUpdated(server, cmd.convId);
          log("info", `handler: conversation ${cmd.convId} switched to ${nextProvider}/${nextModel} (effort=${nextEffort}, fastMode=${nextFastMode})`);
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
        if (!isFastMode(cmd.enabled) || (cmd.enabled && !supportsFastMode(conv.provider, conv.model, cmd.enabled))) {
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
          log("info", `handler: fast mode ${cmd.enabled === "ultrafast" ? "ultrafast" : cmd.enabled ? "enabled" : "disabled"} for ${cmd.convId}`);
        } else {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
        }
        break;
      }

      // ── Sidebar/list commands ─────────────────────────────────────

      case "list_conversations": {
        server.sendTo(client, conversationsListFor(client, cmd.reqId));
        server.sendTo(client, { type: "queue_updated", messages: visibleQueuedMessages() });
        break;
      }

      case "delete_conversation": {
        // App conversations are deleted for good, with what the daemon created for them.
        if (isAppConversation(cmd.convId)) {
          if (!await endAppConversation(cmd.convId, "deleted", { client, reqId: cmd.reqId })) {
            server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
          }
          break;
        }
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
        const appIds = cmd.convIds.filter(isAppConversation);
        for (const convId of appIds) await endAppConversation(convId, "deleted");
        const ordinaryIds = cmd.convIds.filter(convId => !appIds.includes(convId));
        const deleted = ordinaryIds.length > 0 ? convStore.removeMany(ordinaryIds) : [];
        if (appIds.length > 0 && deleted.length === 0) break;
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
        const previousSidebarState = convStore.listSidebarState();
        const ok = convStore.pin(cmd.convId, cmd.pinned);
        if (ok) {
          // One authoritative patch carries the final pinned flag and order. A
          // separate conversation_pinned event caused flicker with stale order.
          broadcastSidebarStatePatch(previousSidebarState);
        }
        break;
      }

      case "mute_conversation": {
        if (convStore.mute(cmd.convId, cmd.muted)) {
          broadcastConversationUpdated(server, cmd.convId);
        }
        break;
      }

      case "move_conversation": {
        const updates = convStore.moveSidebarItemWithUpdates({ type: "conversation", id: cmd.convId }, cmd.direction);
        if (updates) broadcastSidebarItemOrderUpdates(updates);
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
        if (!convStore.hasConversation(cmd.convId)) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
          break;
        }
        const started = startTitleGeneration(server, cmd.convId, { force: true });
        server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
        log("info", `handler: title generation ${started ? "started" : "skipped"} for ${cmd.convId}`);
        break;
      }

      case "clone_conversation": {
        const previousSidebarState = convStore.listSidebarState();
        const cloned = convStore.clone(cmd.convId);
        if (cloned) {
          log("info", `handler: cloned conversation ${cmd.convId} → ${cloned.id}`);
          server.broadcast({ type: "conversation_restored", reqId: cmd.reqId, summary: cloned });
          broadcastSidebarStatePatch(previousSidebarState);
        } else {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
        }
        break;
      }

      // ── Folder/sidebar organization commands ──────────────────────

      case "create_folder": {
        const previousSidebarState = convStore.listSidebarState();
        const folder = convStore.createFolder(cmd.name, cmd.parentId ?? null, cmd.items ?? []);
        if (folder) {
          server.sendTo(client, { type: "ack", reqId: cmd.reqId });
          broadcastSidebarStatePatch(previousSidebarState);
          log("info", `handler: created folder ${folder.id} (${folder.name})`);
        } else {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: "Folder name cannot be empty" });
        }
        break;
      }

      case "rename_folder": {
        const previousSidebarState = convStore.listSidebarState();
        const ok = convStore.renameFolder(cmd.folderId, cmd.name);
        if (ok) {
          server.sendTo(client, { type: "ack", reqId: cmd.reqId });
          broadcastSidebarStatePatch(previousSidebarState);
        } else {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Folder ${cmd.folderId} not found` });
        }
        break;
      }

      case "pin_folder": {
        const previousSidebarState = convStore.listSidebarState();
        if (convStore.pinFolder(cmd.folderId, cmd.pinned)) {
          broadcastSidebarStatePatch(previousSidebarState);
        }
        break;
      }

      case "mute_folder": {
        const previousSidebarState = convStore.listSidebarState();
        if (convStore.muteFolder(cmd.folderId, cmd.muted)) {
          broadcastSidebarStatePatch(previousSidebarState);
        }
        break;
      }

      case "pin_sidebar_items": {
        const previousSidebarState = convStore.listSidebarState();
        if (convStore.pinSidebarItems(cmd.pins)) {
          broadcastSidebarStatePatch(previousSidebarState);
        }
        break;
      }

      case "move_sidebar_item": {
        const updates = convStore.moveSidebarItemWithUpdates(cmd.item, cmd.direction);
        if (updates) {
          broadcastSidebarItemOrderUpdates(updates);
        } else if (cmd.reqId) {
          // The initiating TUI already swapped these rows; the authoritative
          // list lets it roll that back.
          server.sendTo(client, { type: "conversations_list", reqId: cmd.reqId, ...convStore.listSidebarState() });
        }
        break;
      }

      case "move_sidebar_items": {
        const previousSidebarState = convStore.listSidebarState();
        if (convStore.moveSidebarItems(cmd.items, cmd.parentId, cmd.before, { preservePinned: cmd.preservePinned, placement: cmd.placement })) {
          broadcastSidebarStatePatch(previousSidebarState);
        } else {
          // An optimistic TUI may already have projected this move. Return a
          // complete authoritative sidebar when stale/invalid input prevents the
          // mutation so the initiating client can immediately roll it back.
          server.sendTo(client, { type: "conversations_list", reqId: cmd.reqId, ...convStore.listSidebarState() });
        }
        break;
      }

      case "delete_folder": {
        const previousSidebarState = convStore.listSidebarState();
        const mode = cmd.mode ?? "recursive";
        const deletedConvIds = mode === "recursive" ? convStore.listFolderConversationIds(cmd.folderId) : [];
        if (convStore.deleteFolder(cmd.folderId, mode)) {
          for (const convId of deletedConvIds) {
            server.broadcast({ type: "conversation_deleted", convId });
          }
          broadcastSidebarStatePatch(previousSidebarState);
        } else {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Folder ${cmd.folderId} not found` });
        }
        break;
      }

      case "undo_delete": {
        const previousSidebarState = convStore.listSidebarState();
        broadcastSidebarUndoResult(client, cmd.reqId, await convStore.undoDeleteAsync(), "Nothing to undo", previousSidebarState);
        break;
      }

      case "redo_delete": {
        const previousSidebarState = convStore.listSidebarState();
        broadcastSidebarUndoResult(client, cmd.reqId, await convStore.redoDeleteAsync(), "Nothing to redo", previousSidebarState);
        break;
      }

      // ── Queue/system/history commands ─────────────────────────────

      case "queue_message": {
        noteUserWroteFrom(client, cmd.convId);
        rememberSentImages(cmd.images);
        const delegationTarget = convStore.getPolicyMetadata(cmd.convId);
        if (delegationTarget && (cmd.delegation || delegationTarget.subagentPolicy)) {
          try { assertDelegationModel(delegationTarget.provider, delegationTarget.model, cmd.legacy); }
          catch (error) {
            server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: error instanceof Error ? error.message : String(error) });
            break;
          }
        }
        const queueId = cmd.queueId?.trim();
        let queuedCommand: { name: string } | undefined;
        let queuedDraftSettings: {
          provider: import("./messages").ProviderId;
          model: import("./messages").ModelId;
          effort: import("./messages").EffortLevel;
          fastMode: FastMode;
          folderId: string | null;
        } | null = null;
        if (queueId && (queueId.length > 200 || /[\r\n]/.test(queueId))) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: "Invalid queue id" });
          server.sendTo(client, { type: "queue_updated", messages: convStore.listQueuedMessages(), settledQueueIds: [queueId] });
          break;
        }
        if (cmd.source !== "global-idle" && cmd.timing !== "next-turn" && cmd.timing !== "message-end") {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: "Invalid queue timing" });
          server.sendTo(client, { type: "queue_updated", messages: convStore.listQueuedMessages(), ...(queueId ? { settledQueueIds: [queueId] } : {}) });
          break;
        }
        if (queueId && convStore.getQueuedMessageById(queueId)) {
          // Idempotent replay after a socket reconnect.
          server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
          server.sendTo(client, { type: "queue_updated", messages: convStore.listQueuedMessages(), settledQueueIds: [queueId] });
          break;
        }
        if (queueId && convStore.hasMessageMetadata(cmd.convId, { queueEntryId: queueId })) {
          // The daemon may have accepted and removed this entry before the
          // caller observed its acknowledgement. Durable history deduplicates
          // that replay as well as queue-file crash recovery.
          server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
          server.sendTo(client, { type: "queue_updated", messages: convStore.listQueuedMessages(), settledQueueIds: [queueId] });
          break;
        }

        let queuedCommandError: string | null = null;
        const rawWaitTarget = cmd.waitTarget as unknown as Record<string, unknown> | undefined;
        if (rawWaitTarget?.type === "delay"
            && (cmd.source !== "global-idle" || !isDurationMs(rawWaitTarget.delayMs) || typeof rawWaitTarget.label !== "string")) {
          queuedCommandError = "Invalid queue delay";
        } else if (cmd.command !== undefined) {
          const rawCommand = cmd.command as unknown;
          const name = rawCommand && typeof rawCommand === "object"
            ? (rawCommand as Record<string, unknown>).name
            : undefined;
          if (typeof name !== "string" || !name.startsWith("/") || name.length > 100 || /[\r\n]/.test(name)) {
            queuedCommandError = "Invalid queued command";
          } else {
            const definition = queuedCommandDefinitions.get(name);
            if (!definition) queuedCommandError = `Unsupported queued command: ${name}`;
            else if (cmd.source !== "global-idle" || cmd.target === "new-conversation" || (cmd.images?.length ?? 0) > 0) {
              queuedCommandError = `Queued ${name} must target an existing conversation through the global-idle queue without attachments`;
            } else {
              queuedCommandError = definition.validate(cmd.text);
              if (!queuedCommandError) queuedCommand = { name };
            }
          }
        }

        if (queuedCommandError) {
          server.sendTo(client, {
            type: "error",
            reqId: cmd.reqId,
            convId: cmd.convId,
            message: queuedCommandError,
          });
          server.sendTo(client, {
            type: "queue_updated",
            messages: convStore.listQueuedMessages(),
            ...(queueId ? { settledQueueIds: [queueId] } : {}),
          });
          break;
        }

        if (cmd.draftToolPolicyId !== undefined) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: "Tool selection is retired." });
          break;
        }

        if (cmd.source === "global-idle" && cmd.target === "new-conversation") {
          if (!isSafeClientConversationId(cmd.convId)
              || convStore.hasConversation(cmd.convId)
              || convStore.hasDeletedConversation(cmd.convId)) {
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
          const daybreakError = daybreakSelectionError(provider, model);
          if (daybreakError) {
            server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: daybreakError });
            server.sendTo(client, { type: "queue_updated", messages: convStore.listQueuedMessages(), ...(queueId ? { settledQueueIds: [queueId] } : {}) });
            break;
          }
          const effort = normalizeEffort(provider, model, cmd.effort ?? effortDefaultForSelection(provider, model));
          if (cmd.fastMode !== undefined && (!isFastMode(cmd.fastMode) || (cmd.fastMode && !supportsFastMode(provider, model, cmd.fastMode)))) {
            server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Fast mode is only available for ${provider} conversations that support it.` });
            server.sendTo(client, { type: "queue_updated", messages: convStore.listQueuedMessages(), ...(queueId ? { settledQueueIds: [queueId] } : {}) });
            break;
          }
          const requestedFastMode = cmd.fastMode ?? fastDefaultForSelection(provider, model);
          const fastMode = supportsFastMode(provider, model, requestedFastMode) ? requestedFastMode : false;
          const folderId = cmd.folderId ?? null;
          if (folderId && !convStore.listSidebarState().folders.some(folder => folder.id === folderId)) {
            server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Folder ${folderId} not found` });
            server.sendTo(client, { type: "queue_updated", messages: convStore.listQueuedMessages(), ...(queueId ? { settledQueueIds: [queueId] } : {}) });
            break;
          }
          queuedDraftSettings = { provider, model, effort, fastMode, folderId };
        } else if (!convStore.hasConversation(cmd.convId)) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
          server.sendTo(client, { type: "queue_updated", messages: convStore.listQueuedMessages(), ...(queueId ? { settledQueueIds: [queueId] } : {}) });
          break;
        }

        if (cmd.source === "global-idle") {
          convStore.pushGlobalIdleQueuedMessage(cmd.convId, cmd.text, cmd.images, {
            id: queueId,
            command: queuedCommand,
            target: cmd.target ?? "conversation",
            provider: queuedDraftSettings?.provider ?? cmd.provider,
            model: queuedDraftSettings?.model ?? cmd.model,
            effort: queuedDraftSettings?.effort ?? cmd.effort,
            fastMode: queuedDraftSettings?.fastMode ?? cmd.fastMode,
            folderId: queuedDraftSettings?.folderId ?? cmd.folderId,
            waitTarget: cmd.waitTarget,
          });
        } else {
          // A turn only sleeping or waiting in chrono takes a new prompt now, as a
          // suspended chrono sleep resumes on one.
          const timing = cmd.timing === "message-end" && convStore.getActiveBackgroundableToolName(cmd.convId) === "chrono"
            ? "next-turn"
            : cmd.timing;
          convStore.pushQueuedMessage(cmd.convId, cmd.text, timing, cmd.images, undefined, undefined, queueId,
            undefined, cliDelegationAutomation(cmd));
          // Instant steering: a next-turn prompt preempts the active turn now.
          if (timing === "next-turn") convStore.steerActiveTurn(cmd.convId);
        }
        if (queuedDraftSettings) {
          const { provider, model, effort, fastMode, folderId } = queuedDraftSettings;
          // Queue persistence happens first. If the daemon dies before creation,
          // the scheduler reconstructs this draft from the captured settings.
          convStore.create(
            cmd.convId,
            provider,
            model,
            PENDING_TITLE,
            effort,
            fastMode,
            folderId,
          );
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
        log("info", `handler: queued ${queuedCommand?.name ?? `${cmd.timing} message`} for ${cmd.convId}: "${cmd.text.slice(0, 50)}"`);
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
        rememberSentImages(cmd.images);
        const existing = convStore.getQueuedMessageById(cmd.queueId);
        if (existing?.command) {
          const definition = queuedCommandDefinitions.get(existing.command.name);
          const validationError = cmd.images?.length
            ? `Queued ${existing.command.name} cannot have attachments`
            : definition?.validate(cmd.text) ?? `Unsupported queued command: ${existing.command.name}`;
          if (validationError) {
            server.sendTo(client, { type: "error", reqId: cmd.reqId, message: validationError });
            break;
          }
        }
        const ok = !!existing && convStore.updateQueuedMessage(cmd.queueId, cmd.text, cmd.timing, cmd.images);
        if (ok) server.sendTo(client, { type: "ack", reqId: cmd.reqId });
        else server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Queued message ${cmd.queueId} not found` });
        if (ok && cmd.timing === "next-turn") convStore.steerActiveTurn(existing.convId);
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

      case "load_instructions": {
        const convId = cmd.convId ?? null;
        const folderId = cmd.folderId ?? null;
        const conversation = convId ? convStore.getSystemInstructions(convId) ?? (convStore.get(convId) ? "" : null) : null;
        if (convId && conversation === null) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Conversation ${convId} not found` });
          break;
        }
        const folder = folderId ? convStore.getFolderInstructions(folderId) : null;
        let global: string;
        try {
          global = reloadUserAddendum();
        } catch {
          global = getUserAddendum();
        }
        server.sendTo(client, {
          type: "instructions_loaded", reqId: cmd.reqId, convId, folderId: folder === null ? null : folderId,
          conversation, folder, global, globalBase: getBaseInstructions(),
        });
        break;
      }

      case "set_global_instructions": {
        try {
          setUserAddendum(cmd.text, cmd.expectedText);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Could not save global instructions: ${message}` });
          break;
        }
        server.broadcast({ type: "global_instructions_updated", reqId: cmd.reqId, text: getUserAddendum() });
        log("info", `handler: global instructions ${cmd.text.trim() ? "set" : "cleared"}`);
        break;
      }

      case "unwind_conversation": {
        // Reconnecting clients can replay this before restoring their socket
        // subscription. Subscribe even if validation later rejects the unwind so
        // an error cannot leave the active TUI detached from future events.
        server.subscribe(client, cmd.convId);
        // An unwind is a durable rewrite; an ephemeral conversation has nothing durable.
        if (isEphemeralConversation(cmd.convId)) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: "Ephemeral app conversations cannot be unwound." });
          break;
        }
        // operationId was introduced together with the targeted response. It is
        // also a reconnect-safe capability signal if the hello has not arrived.
        if (typeof cmd.operationId === "string" && cmd.operationId.length > 0) {
          client.capabilities.add("targeted-unwind");
        }
        const targetedRequester = client.capabilities.has("targeted-unwind");
        if (targetedRequester && cmd.expectedStartedAt === undefined && !cmd.targetFingerprint) {
          server.sendTo(client, {
            type: "error",
            reqId: cmd.reqId,
            convId: cmd.convId,
            message: "Cannot unwind without a stable target identity",
          });
          break;
        }
        const operationId = typeof cmd.operationId === "string" && cmd.operationId.length > 0
          ? cmd.operationId
          : randomUUID();
        const deliverResult = (
          unwindResult: convStore.ConversationUnwindResult,
          broadcast: boolean,
          releaseLease: boolean,
        ): void => {
          try {
            log("info", `handler: unwound conversation ${cmd.convId} to before user message ${cmd.userMessageIndex}`);
            const event = {
              type: "conversation_unwound" as const,
              ...unwindResult,
              // A replay receipt may outlive unrelated sidebar mutations. Always
              // patch with the summary current at this synchronous publication.
              summary: convStore.getSummary(cmd.convId) ?? unwindResult.summary,
            };
            const needsLegacyHistory = !targetedRequester
              || (broadcast && server.hasLegacyUnwindSubscribers(cmd.convId));
            const legacyHistory = needsLegacyHistory
              ? (() => {
                  const data = getRenderSnapshot(cmd.convId);
                  return data ? buildHistoryUpdatedEvents(data, { resetHistoryWindow: true }) : undefined;
                })()
              : undefined;
            if (!targetedRequester) sendCompactConversationLoaded(client, cmd.convId, cmd.reqId);
            server.deliverConversationUnwind(
              event,
              client,
              { ...event, reqId: cmd.reqId },
              broadcast,
              legacyHistory,
            );
          } finally {
            if (releaseLease) convStore.releaseHistoryUnwindLease(cmd.convId, operationId);
          }
        };
        let result: convStore.ConversationUnwindResult | null;
        try {
          result = await convStore.unwindTo(
            cmd.convId,
            cmd.userMessageIndex,
            operationId,
            cmd.expectedStartedAt,
            cmd.targetFingerprint,
            true,
            (committed) => deliverResult(committed, true, true),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log("error", `handler: unwind failed for ${cmd.convId}: ${message}`);
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message });
          if (err instanceof convStore.HistoryUnwindRefreshRequiredError) {
            try {
              // The stream finalizer intentionally withheld its obsolete tail
              // while the cut was pending. Publish the restored canonical state
              // before releasing the mutation lease.
              sendCompactHistoryUpdated(cmd.convId, true);
              broadcastConversationUpdated(server, cmd.convId);
            } finally {
              convStore.releaseHistoryUnwindLease(cmd.convId, operationId);
            }
          }
          break;
        }
        if (!result) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Cannot unwind conversation ${cmd.convId}` });
          break;
        }
        // Applied results were published by the synchronous commit callback.
        // Replays only need a correlated response for their requesting client.
        if (result.status === "already_applied") deliverResult(result, false, false);
        break;
      }

      case "get_image": {
        const request = { format: cmd.format, width: cmd.width, height: cmd.height, ...(cmd.purpose ? { purpose: cmd.purpose } : {}) };
        const invalid = !isImageId(cmd.imageId) ? "Invalid image id" : validatePreviewRequest(request);
        if (invalid) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `get_image: ${invalid}` });
          break;
        }
        try {
          // A rendered preview needs neither the image's bytes nor a conversation scan.
          let preview = cachedImagePreview(cmd.imageId, request);
          if (!preview) {
            const source = await resolveImageForPreview(cmd.imageId, cmd.convId);
            if (!source) {
              server.sendTo(client, { type: "error", reqId: cmd.reqId, message: "get_image: image not found" });
              break;
            }
            preview = await renderImagePreview(cmd.imageId, source, request);
          }
          server.sendTo(client, {
            type: "image_data",
            reqId: cmd.reqId,
            imageId: cmd.imageId,
            format: preview.format,
            width: preview.width,
            height: preview.height,
            base64: preview.data.toString("base64"),
          });
        } catch (error) {
          log("warn", `get_image ${cmd.imageId.slice(0, 12)} failed: ${error instanceof Error ? error.message : String(error)}`);
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `get_image: ${error instanceof Error ? error.message : String(error)}` });
        }
        break;
      }

      case "load_display_blocks": {
        const ranges = cmd.ranges;
        if (!Array.isArray(ranges) || ranges.length === 0 || ranges.length > MAX_DISPLAY_BLOCK_RANGES
            || ranges.some((range) => !range || !Number.isSafeInteger(range.entry) || range.entry < 0
              || !Number.isSafeInteger(range.start) || range.start < 0
              || !Number.isSafeInteger(range.end) || range.end <= range.start)
            || (cmd.maxBytes !== undefined && (!Number.isSafeInteger(cmd.maxBytes) || cmd.maxBytes < 1))) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: "Invalid display block selection" });
          break;
        }
        let entries;
        try {
          entries = convStore.getDisplayEntries(cmd.convId, ranges.map((range) => range.entry));
        } catch (error) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Could not load display blocks: ${error instanceof Error ? error.message : String(error)}` });
          break;
        }
        if (!entries) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
          break;
        }
        // Ranges are answered in order until the response is this large; the client asks again for the rest.
        const responseBytes = Math.min(cmd.maxBytes ?? DISPLAY_BLOCKS_RESPONSE_BYTES, DISPLAY_BLOCKS_RESPONSE_BYTES);
        let bytes = 0;
        let truncated = false;
        const loaded: Array<{ entry: number; start: number; blocks: Block[] }> = [];
        for (const range of ranges) {
          const entry = entries.get(range.entry);
          if (entry?.type !== "ai" || range.start >= entry.blocks.length) continue;
          const blocks: Block[] = [];
          for (let index = range.start; index < Math.min(range.end, entry.blocks.length); index++) {
            const block = entry.blocks[index]!;
            const blockBytes = JSON.stringify(block).length;
            if (bytes > 0 && bytes + blockBytes > responseBytes) { truncated = true; break; }
            bytes += blockBytes;
            blocks.push(block);
          }
          if (blocks.length > 0) loaded.push({ entry: range.entry, start: range.start, blocks });
          if (truncated) break;
        }
        server.sendTo(client, { type: "display_blocks_loaded", reqId: cmd.reqId, convId: cmd.convId, ranges: loaded, ...(truncated ? { truncated } : {}) });
        break;
      }

      case "load_tool_outputs": {
        if (cmd.toolCallIds !== undefined && (
          !Array.isArray(cmd.toolCallIds)
          || cmd.toolCallIds.length > 50_000
          || cmd.toolCallIds.some((id) => typeof id !== "string" || id.length === 0 || id.length > 1_024)
        )) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: "Invalid tool output selection" });
          break;
        }
        const loadStartedAt = PERFORMANCE_PROFILING_ENABLED ? performance.now() : 0;
        let outputs;
        try {
          outputs=isSqliteConversationStore()
            ? await loadToolOutputsOffThread(cmd.convId,cmd.toolCallIds)
            : convStore.getToolOutputs(cmd.convId,cmd.toolCallIds);
        } catch(error) {
          server.sendTo(client,{type:"error",reqId:cmd.reqId,convId:cmd.convId,message:`Could not load verified archive output: ${error instanceof Error?error.message:String(error)}`});
          break;
        }
        const loadMs = PERFORMANCE_PROFILING_ENABLED ? performance.now() - loadStartedAt : 0;
        if (!outputs) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
          break;
        }
        const sendStartedAt = PERFORMANCE_PROFILING_ENABLED ? performance.now() : 0;
        const responseBytes = server.sendTo(
          client,
          { type: "tool_outputs_loaded", reqId: cmd.reqId, convId: cmd.convId, outputs },
          PERFORMANCE_PROFILING_ENABLED,
        );
        if (PERFORMANCE_PROFILING_ENABLED) {
          const sendMs = performance.now() - sendStartedAt;
          log(loadMs + sendMs >= 100 ? "warn" : "info", `perf: tool_outputs daemon_response ${JSON.stringify({
            reqId: cmd.reqId ?? null,
            convId: cmd.convId,
            requested: cmd.toolCallIds?.length ?? null,
            returned: outputs.length,
            loadMs,
            sendMs,
            responseBytes,
          })}`);
        }
        break;
      }

      case "load_conversation": {
        const startedAt = PERFORMANCE_PROFILING_ENABLED ? performance.now() : 0;
        const queueDelayMs = PERFORMANCE_PROFILING_ENABLED
          && typeof cmd.requestedAt === "number" && Number.isFinite(cmd.requestedAt)
          ? Math.max(0, Date.now() - cmd.requestedAt)
          : null;
        if (PERFORMANCE_PROFILING_ENABLED) {
          log("info", `perf: conversation_open daemon_start ${JSON.stringify({
            reqId: cmd.reqId ?? null,
            convId: cmd.convId,
            clientId: client.id ?? null,
            turns: cmd.turns ?? null,
            viewport: cmd.viewport ?? null,
            queueDelayMs,
          })}`);
        }
        if (cmd.turns !== undefined && (!Number.isSafeInteger(cmd.turns) || cmd.turns < 1 || cmd.turns > MAX_HISTORY_REQUEST_TURNS)) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: "Invalid conversation history turn count" });
          break;
        }
        if (cmd.viewport !== undefined && !isValidHistoryViewport(cmd.viewport)) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: "Invalid conversation history viewport" });
          break;
        }
        if (cmd.turns !== undefined) client.capabilities?.add("history-pagination");
        const metrics = PERFORMANCE_PROFILING_ENABLED ? createConversationLoadMetrics() : undefined;
        // The page the client would ask for next rides right behind this one.
        const backfill = isValidInitialBackfill(cmd.initialBackfill) ? cmd.initialBackfill : undefined;
        const loaded = sendCompactConversationLoaded(client, cmd.convId, cmd.reqId, cmd.turns, metrics, cmd.cachedEntryHashes, cmd.viewport, backfill?.reqId);
        if (!loaded) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
          if (PERFORMANCE_PROFILING_ENABLED) {
            log("warn", `perf: conversation_open daemon_missing ${JSON.stringify({
              reqId: cmd.reqId ?? null,
              convId: cmd.convId,
              durationMs: performance.now() - startedAt,
              queueDelayMs,
            })}`);
          }
          break;
        }
        const loadedConvId = loaded.convId;
        // A peek only refreshes a client's copy: it opens nothing.
        const peek = cmd.peek === true;
        if (!peek && cmd.turns !== undefined && isSqliteConversationStore()
            && !convStore.getCached(loadedConvId) && !convStore.isStreaming(loadedConvId)) {
          scheduleConversationPrewarm(loadedConvId);
        }
        if (!peek) server.subscribe(client, loadedConvId);
        // Reconcile any BTW updates emitted between the load snapshot and this
        // subscription, just like the active-turn catch-up below. An all-null
        // pair needs no redundant event; a loaded panel followed by a close must
        // still send the authoritative null snapshot.
        if (!peek && (loaded.btwSessionId || btwManager.getSnapshot(loadedConvId))) {
          btwManager.sendSnapshot(client, loadedConvId);
        }
        // After subscribing, send a fresh streaming snapshot for late-join catch-up.
        // This covers any chunks emitted between the initial load snapshot and the
        // moment the new subscriber was attached.
        if (!peek && convStore.isStreaming(loadedConvId)) {
          const pendingAI = convStore.getPendingStreamSnapshot(loadedConvId);
          const loadedSummary = convStore.getSummary(loadedConvId);
          if (pendingAI && loadedSummary) {
            server.sendTo(client, {
              type: "streaming_started",
              convId: loadedConvId,
              provider: loadedSummary.provider,
              model: loadedSummary.model,
              streamSeq: convStore.getStreamSeq(loadedConvId),
              snapshotKind: "catchup",
              startedAt: pendingAI.metadata?.startedAt ?? Date.now(),
              workTimerStartedAt: pendingAI.metadata?.workTimerStartedAt,
              blocks: pendingAI.blocks,
              blockOffset: pendingAI.blockOffset,
              tokens: pendingAI.metadata?.tokens ?? 0,
              generationThroughput: pendingAI.metadata?.generationThroughput,
              compactionStartedAt: convStore.getContextCompactionStartedAt(loadedConvId) ?? null,
              connectionWaitStartedAt: convStore.getConnectionWaitStartedAt(loadedConvId) ?? null,
              connectionWaitLabel: convStore.getConnectionWaitLabel(loadedConvId) ?? null,
            });
          }
        }
        // Last, so nothing the first paint needs waits behind it on the wire.
        // Same synchronous snapshot as the loaded page, so it ends where that begins.
        if (backfill && loaded.olderCursor) {
          const sent = sendCompactConversationHistory(
            client,
            loadedConvId,
            loaded.olderCursor.beforeEntryIndex,
            loaded.olderCursor.beforeBlockIndex,
            backfill.turns,
            backfill.reqId,
            "initial-backfill",
            undefined,
            backfill.cachedEntryHashes,
            cmd.viewport?.folded === true,
          );
          if (!sent) server.sendTo(client, { type: "error", reqId: backfill.reqId, convId: loadedConvId, message: `Conversation ${loadedConvId} not found` });
        }
        // Clear unread when a client views the conversation
        if (!peek && convStore.clearUnread(loadedConvId)) {
          broadcastConversationUpdated(server, loadedConvId);
        }
        if (PERFORMANCE_PROFILING_ENABLED && metrics) {
          const durationMs = performance.now() - startedAt;
          log(durationMs >= 250 || (queueDelayMs ?? 0) >= 250 ? "warn" : "info", `perf: conversation_open daemon_complete ${JSON.stringify({
            reqId: cmd.reqId ?? null,
            convId: cmd.convId,
            clientId: client.id ?? null,
            durationMs,
            queueDelayMs,
            ...metrics,
          })}`);
        }
        break;
      }

      case "load_conversation_history": {
        const startedAt = PERFORMANCE_PROFILING_ENABLED ? performance.now() : 0;
        if (PERFORMANCE_PROFILING_ENABLED) {
          log("info", `perf: conversation_history daemon_start ${JSON.stringify({
            reqId: cmd.reqId ?? null,
            convId: cmd.convId,
            clientId: client.id ?? null,
            requestSource: cmd.requestSource ?? null,
            turns: cmd.turns,
            beforeEntryIndex: cmd.beforeEntryIndex,
            beforeBlockIndex: cmd.beforeBlockIndex ?? null,
          })}`);
        }
        const beforeBlockIndex = cmd.beforeBlockIndex ?? 0;
        if (!Number.isSafeInteger(cmd.beforeEntryIndex) || cmd.beforeEntryIndex < 0
            || !Number.isSafeInteger(beforeBlockIndex) || beforeBlockIndex < 0
            || !Number.isSafeInteger(cmd.turns) || cmd.turns < 1 || cmd.turns > 100) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: "Invalid conversation history page request" });
          break;
        }
        client.capabilities?.add("history-pagination");
        const metrics = PERFORMANCE_PROFILING_ENABLED ? createConversationLoadMetrics() : undefined;
        const sent = sendCompactConversationHistory(
          client,
          cmd.convId,
          cmd.beforeEntryIndex,
          beforeBlockIndex,
          cmd.turns,
          cmd.reqId,
          cmd.requestSource,
          metrics,
          cmd.cachedEntryHashes,
          cmd.folded === true,
        );
        if (!sent) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
        }
        if (PERFORMANCE_PROFILING_ENABLED && metrics) {
          const durationMs = performance.now() - startedAt;
          log(durationMs >= 250 ? "warn" : "info", `perf: conversation_history daemon_complete ${JSON.stringify({
            reqId: cmd.reqId ?? null,
            convId: cmd.convId,
            clientId: client.id ?? null,
            requestSource: cmd.requestSource ?? null,
            durationMs,
            sent,
            ...metrics,
          })}`);
        }
        break;
      }

      // ── Utility/tool/auth commands ────────────────────────────────

      case "load_tool_instructions": {
        const conversation = cmd.convId ? convStore.get(cmd.convId) : undefined;
        if (cmd.convId && !conversation) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Conversation ${cmd.convId} not found` });
          break;
        }
        const provider = conversation?.provider ?? (cmd.provider && getProvider(cmd.provider) ? cmd.provider : getDefaultProvider().id);
        const model = conversation?.model ?? cmd.model ?? getDefaultModel(provider);
        server.sendTo(client, {
          type: "tool_instructions_loaded",
          reqId: cmd.reqId,
          convId: cmd.convId ?? null,
          provider,
          model,
          ...describeToolInstructions(provider, model, cmd.convId),
        });
        break;
      }

      case "save_tool_instructions": {
        const conversation = cmd.convId ? convStore.get(cmd.convId) : undefined;
        if (cmd.convId && !conversation) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Conversation ${cmd.convId} not found` });
          break;
        }
        const provider = conversation?.provider ?? (cmd.provider && getProvider(cmd.provider) ? cmd.provider : getDefaultProvider().id);
        const model = conversation?.model ?? cmd.model ?? getDefaultModel(provider);
        // Committing and pushing take a while: answer when they finish.
        void saveToolInstructions({ provider, model, ...(cmd.convId ? { convId: cmd.convId } : {}) }, cmd.edits, cmd.force === true)
          .then((result) => server.sendTo(client, { type: "tool_instructions_saved", reqId: cmd.reqId, ...result }))
          .catch((error) => {
            const message = error instanceof ToolInstructionsSaveError ? error.message : `Could not save tool instructions: ${error instanceof Error ? error.message : String(error)}`;
            if (!(error instanceof ToolInstructionsSaveError)) log("error", `handler: save_tool_instructions: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
            server.sendTo(client, { type: "error", reqId: cmd.reqId, message });
          });
        break;
      }

      case "get_system_prompt": {
        const instructions = cmd.convId ? convStore.getEffectiveSystemInstructions(cmd.convId) : null;
        const conversation = cmd.convId ? convStore.get(cmd.convId) : undefined;
        const subagentMaxDepth = conversation?.subagentMaxDepth ?? null;
        const scopedPromptOptions = conversation
          ? scopedSubagentPromptOptions(conversation, subagentMaxDepth)
          : null;
        if (conversation?.provider === "anthropic") {
          const append = buildClaudeCodeSystemAppend({
            conversationInstructions: instructions ?? undefined,
            ...(scopedPromptOptions ?? {}),
          });
          server.sendTo(client, {
            type: "system_prompt",
            reqId: cmd.reqId,
            systemPrompt: append
              ? `Claude Code's own system prompt, with Exocortex appending:\n\n${append}`
              : "Claude Code's own system prompt (Exocortex appends nothing).",
          });
          break;
        }
        const workingDirectory = conversation ? ensureConversationWorkspace(conversation.id) : undefined;
        server.sendTo(client, {
          type: "system_prompt",
          reqId: cmd.reqId,
          systemPrompt: buildSystemPrompt({
            conversationInstructions: instructions ?? undefined,
            conversationId: cmd.convId,
            workingDirectory,
            subagentMaxDepth,
            ...(scopedPromptOptions ?? {}),
            toolNames: getConversationToolNames(conversation?.provider),
            provider: conversation?.provider,
          }),
        });
        break;
      }

      case "list_tasks": {
        if (cmd.convId !== undefined && !convStore.getSummary(cmd.convId)) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: "Conversation not found." });
          break;
        }
        server.sendTo(client, { type: "tasks_list", reqId: cmd.reqId, tasks: listActiveConversationTasks(cmd.convId) });
        break;
      }

      case "stop_task": {
        const task = listActiveConversationTasks(cmd.convId).find(task => task.id === cmd.taskId);
        if (!task || task.ownerConversationId !== cmd.convId) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: "Exact managed task not found for this conversation." });
          break;
        }
        if (task.kind !== "background") {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: "Use abort for subagent conversations or Chrono cancellation for schedules." });
          break;
        }
        const stopped = stopBackgroundTask(cmd.taskId, true);
        if (stopped.result !== "stopping" && stopped.result !== "already-stopping") {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Cannot stop task: ${stopped.result}.` });
          break;
        }
        broadcastConversationUpdated(server, cmd.convId);
        server.sendTo(client, { type: "task_stopped", reqId: cmd.reqId, convId: cmd.convId, taskId: cmd.taskId, status: "stopping" });
        break;
      }

      // Explicit errors for old clients; no policy runtime is loaded.
      case "get_tool_policy":
      case "get_draft_tool_policy":
      case "set_draft_tool_policy":
      case "clear_draft_tool_policy":
      case "set_tool_policy": {
        server.sendTo(client, { type: "error", reqId: cmd.reqId, message: "Tool selection is retired." });
        break;
      }

      case "llm_complete": {
        let delegationSelection: ReturnType<typeof resolveDelegationModel> | undefined;
        if (cmd.delegation) {
          try { delegationSelection = resolveDelegationModel(cmd); }
          catch (error) {
            server.sendTo(client, { type: "error", reqId: cmd.reqId, message: error instanceof Error ? error.message : String(error) });
            break;
          }
        }
        const provider = delegationSelection?.provider ?? cmd.provider ?? inferProviderForModel(cmd.model) ?? effectiveConversationDefaults().provider;
        if (!getProvider(provider)) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Unknown provider: ${provider}` });
          break;
        }
        const model = delegationSelection?.model ?? cmd.model ?? modelDefaultForProvider(provider);
        if (!isKnownModel(provider, model) && !allowsCustomModels(provider)) {
          server.sendTo(client, {
            type: "error",
            reqId: cmd.reqId,
            message: unknownModelMessage(provider, model),
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
          effort: delegationSelection?.effort ?? cmd.effort ?? effortDefaultForSelection(provider, model),
          serviceTier: supportsFastMode(provider, model, delegationSelection?.fastMode ?? fastDefaultForSelection(provider, model))
            ? fastModeServiceTier(delegationSelection?.fastMode ?? fastDefaultForSelection(provider, model)) : undefined,
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

        transcribeAudioBytes(audioBytes, { mimeType: cmd.mimeType, filename: cmd.filename })
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

      case "generate_image": {
        // The `image` tool's request: the daemon makes the call with its own
        // OpenAI login so no credential is handed to the tool's process.
        log("info", `handler: generate_image (${cmd.prompt.length} chars)`);
        server.sendTo(client, { type: "ack", reqId: cmd.reqId });
        generateImage(cmd.prompt)
          .then((image) => {
            server.sendTo(client, { type: "image_generation_result", reqId: cmd.reqId, ...image });
          })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            log("error", `handler: generate_image failed: ${msg}`);
            server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Image generation failed: ${msg}` });
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
        if (rejectProxiedProviderAuth(client, cmd.reqId, provider, "log in")) break;

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

      case "accounts":
        accountsWatch.handle(client, cmd);
        break;

      case "account": {
        server.sendTo(client, { type: "ack", reqId: cmd.reqId });
        const provider = cmd.provider ?? "openai";
        if (provider === "anthropic") {
          handleClaudeAccountCommand(client, cmd);
          break;
        }
        if (provider !== "openai") {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Account switching is only supported for OpenAI and Claude.` });
          break;
        }
        if (rejectProxiedProviderAuth(client, cmd.reqId, provider, "switch accounts")) break;

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
        if (rejectProxiedProviderAuth(client, cmd.reqId, provider, "log out")) break;
        if (getProviderAdapter(provider).auth.publicAccessLabel) {
          server.sendTo(client, { type: "auth_status", reqId: cmd.reqId, message: `${getProviderAdapter(provider).label} uses public access and has no session to log out.` });
          break;
        }
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

      // ── App API (docs/app-api.md) ─────────────────────────────────

      case "attach_app_conversation": {
        attachAppConversation(client, cmd);
        break;
      }

      case "end_app_session": {
        await endAppSession(client, cmd);
        break;
      }

      case "app_tool_result": {
        // Late, duplicate and unknown results are ignored.
        appToolBroker.resolve(cmd.convId, cmd.callId, cmd.output, cmd.isError);
        break;
      }

      case "list_app_conversations": {
        listAppConversations(client, cmd);
        break;
      }

      case "app_run": {
        const fail = (message: string) => server.sendTo(client, { type: "error", reqId: cmd.reqId, message });
        if (typeof cmd.prompt !== "string" || (!cmd.prompt.trim() && !cmd.images?.length)) {
          fail("app_run needs a prompt");
          break;
        }
        if (cmd.app === undefined && !client.app) {
          fail("app_run needs an app: name it (app) or declare one in client_capabilities");
          break;
        }
        let id = cmd.convId ?? convStore.generateId();
        while (!cmd.convId && (convStore.hasConversation(id) || convStore.hasDeletedConversation(id))) id = convStore.generateId();
        const lifetime = cmd.lifetime ?? "ephemeral";
        const startedAt = typeof cmd.startedAt === "number" && Number.isFinite(cmd.startedAt) ? cmd.startedAt : Date.now();
        // The same app_run sent again after a reconnect (its own convId): carry on with it instead of creating it twice.
        const resumedRun = cmd.convId !== undefined ? getAppRecord(cmd.convId) : undefined;
        if (resumedRun && convStore.hasConversation(id)) {
          if (resumedRun.app !== (cmd.app ?? client.app?.name)) {
            fail(`Conversation ${id} belongs to app ${resumedRun.app}`);
            break;
          }
          // Answered on this reqId: an error ends the run's request, a success is ignored by clients.
          attachAppConversation(client, { type: "attach_app_conversation", reqId: cmd.reqId, convId: id });
          if (appConversationOwner(id) !== client) break;
          await handleCommand(client, {
            type: "send_message", reqId: cmd.reqId, convId: id, text: cmd.prompt, startedAt,
            ...(cmd.images?.length ? { images: cmd.images } : {}), awaitResult: true,
          });
          break;
        }
        // Validation answers `error` with this reqId before anything is created.
        await handleCommand(client, {
          type: "new_conversation",
          reqId: cmd.reqId,
          convId: id,
          ...(cmd.app !== undefined ? { app: cmd.app } : {}),
          lifetime,
          ...(cmd.idleTtlMs !== undefined ? { idleTtlMs: cmd.idleTtlMs } : {}),
          title: cmd.title ?? appTitleFromPrompt(cmd.prompt),
          ...(cmd.system !== undefined ? { system: cmd.system } : {}),
          ...(cmd.tools !== undefined ? { tools: cmd.tools } : {}),
          ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
          ...(cmd.model !== undefined ? { model: cmd.model } : {}),
          ...(cmd.effort !== undefined ? { effort: cmd.effort } : {}),
          ...(cmd.cwd !== undefined ? { cwd: cmd.cwd } : {}),
          ...(cmd.route !== undefined ? { route: cmd.route } : {}),
        });
        if (!isAppConversation(id) || !convStore.hasConversation(id)) break;
        // Ends with its turn, also one the next daemon replays after a restart.
        const runRecord = getAppRecord(id);
        if (runRecord && lifetime === "ephemeral" && cmd.keep !== true) runRecord.endAfterTurn = true;
        try {
          await handleCommand(client, {
            type: "send_message",
            reqId: cmd.reqId,
            convId: id,
            text: cmd.prompt,
            startedAt,
            ...(cmd.images?.length ? { images: cmd.images } : {}),
            awaitResult: true,
          });
        } finally {
          if (lifetime === "ephemeral" && cmd.keep !== true) await finishAppRun(id);
        }
        break;
      }

      default: {
        const unknown = cmd as unknown as Record<string, unknown>;
        server.sendTo(client, {
          type: "error",
          reqId: unknown.reqId as string | undefined,
          message: `Unknown command: ${unknown.type}`,
        });
      }
    } } catch(error) {
      if(!(error instanceof ConversationIntegrityError))throw error;
      server.sendTo(client,{
        type:"error",reqId:"reqId" in cmd?cmd.reqId:undefined,
        ...("convId" in cmd?{convId:cmd.convId}:{}),
        message:`Could not load verified archive chunk: ${error.message}`,
      });
    }
  };

  return Object.assign(handleCommand, {
    stop: async () => {
      await shutdownAppConversations();
      stopAppApi();
      unsubscribeConnectivity();
      setApiKeyUsageRecordedListener(null);
      setCreditSyncListener(null);
      if (apiKeyDayTimer) clearTimeout(apiKeyDayTimer);
      if (preparedRestartTimer) clearTimeout(preparedRestartTimer);
    },
    backgroundTaskComplete: enqueueBackgroundTaskCompletion,
    providerProxies,
    startQueueDelivery: () => {
      markAppApiReady();
      if (queueDeliveryReady) return;
      queueDeliveryReady = true;
      scheduleQueuePump(0);
    },
  });
}
