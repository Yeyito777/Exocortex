/**
 * Command handler for exocortexd.
 *
 * Routes IPC commands to the appropriate action. Thin dispatcher —
 * orchestration lives in orchestrator.ts, conversation data
 * transformations live in conversations.ts, usage state lives
 * in usage.ts.
 */

import { log } from "./log";
import { refreshUsage, handleUsageHeaders, getLastUsage, clearUsage } from "./usage";
import { orchestrateGoalContinuation, orchestrateReplayConversation, orchestrateSendMessage, type AssistantTurnOutcome } from "./orchestrator";
import { complete } from "./llm";
import { buildSystemPrompt } from "./system";
import { getToolDisplayInfo } from "./tools/registry";
import { getExternalToolStyles, manageExternalToolDaemon } from "./external-tools";
import { EFFORT_LEVELS } from "./messages";
import { getDefaultProvider, getDefaultModel, getProvider, getProviders, isKnownModel, allowsCustomModels, refreshProviders, normalizeEffort, supportsEffort, getSupportedEfforts, supportsFastMode, supportsImageInputs } from "./providers/registry";
import { transcribeAudioBytes } from "./transcription";
import { startTitleGeneration, isPendingTitle, PENDING_TITLE } from "./titlegen";
import * as convStore from "./conversations";
import { DaemonServer, type ConnectedClient } from "./server";
import type { Command, ParentNotificationTarget } from "./protocol";
import type { ConversationRenderSnapshot } from "./conversations";
import type { ImageAttachment } from "./messages";
import { clearAuth, ensureAuthenticated, getAuthByProvider, getAuthInfoByProvider, hasConfiguredCredentials, invalidateCredentialsCache } from "./auth";
import { addAccount as addOpenAIAccount, listAccounts as listOpenAIAccounts, removeAccount as removeOpenAIAccount, switchAccount as switchOpenAIAccount } from "./providers/openai/auth";
import { getProviderAdapter } from "./providers/catalog";
import { getTokenStatsSnapshot } from "./token-stats";
import { broadcastConversationUpdated } from "./conversation-events";
import { applyUserGoalAction, setGoal as setConversationGoal } from "./goals";

const SUBAGENTS_FOLDER_NAME = "subagents";
const RECENT_HISTORY_IMAGE_PAYLOAD_ENTRIES = 8;

// ── Handler ─────────────────────────────────────────────────────────

export function createHandler(server: DaemonServer) {
  // ── Local helper functions ────────────────────────────────────────

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
  });

  const getRenderSnapshot = (convId: string) => convStore.getRenderSnapshot(convId, false);

  const shouldAutoGenerateTitle = (convId: string): boolean => {
    const title = convStore.get(convId)?.title.trim() ?? "";
    return title === "" || isPendingTitle(title);
  };

  const maybeStartAutoTitleGeneration = (convId: string): void => {
    if (shouldAutoGenerateTitle(convId)) startTitleGeneration(server, convId);
  };

  const ensureConversationInSubagentsFolder = (convId: string): void => {
    const folder = convStore.ensureTopLevelFolder(SUBAGENTS_FOLDER_NAME);
    if (!folder) {
      log("warn", `handler: failed to ensure ${SUBAGENTS_FOLDER_NAME} folder for detached subagent ${convId}`);
      return;
    }
    if ((convStore.getSummary(convId)?.folderId ?? null) === folder.id) return;
    if (convStore.moveConversationToFolder(convId, folder.id)) {
      server.broadcast({ type: "conversation_moved", ...convStore.listSidebarState() });
    }
  };

  // ── Subagent parent notifications ────────────────────────────────

  const textFromBlocks = (blocks: import("./messages").Block[]): string => blocks
    .filter((block): block is Extract<import("./messages").Block, { type: "text" }> => block.type === "text")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();

  const capText = (text: string, maxChars: number): string => {
    if (text.length <= maxChars) return text;
    return text.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
  };

  const buildSubagentNotification = (
    childConvId: string,
    task: string,
    outcome: AssistantTurnOutcome,
    maxChars: number,
  ): string => {
    const title = (convStore.get(childConvId)?.title || task.split("\n")[0] || "subagent task").trim();
    const body = outcome.ok
      ? (textFromBlocks(outcome.blocks) || "(subagent completed without text output)")
      : (outcome.error || "Subagent did not complete successfully.");
    const status = outcome.ok ? "completed" : "failed";
    const section = outcome.ok ? "Result" : "Error";
    return [
      `[notification] Subagent ${status}: exo:${childConvId}`,
      `Task: ${capText(title, 160)}`,
      "",
      `${section}:`,
      capText(body, maxChars),
      "",
      "Full details:",
      `exo history ${childConvId} --full`,
    ].join("\n");
  };

  const deliverParentNotification = (
    parent: ParentNotificationTarget,
    childConvId: string,
    task: string,
    outcome: AssistantTurnOutcome,
  ): void => {
    if (parent.convId === childConvId) {
      log("warn", `handler: skipping self-notification for ${childConvId}`);
      return;
    }
    if (!convStore.get(parent.convId)) {
      log("warn", `handler: parent conversation ${parent.convId} not found for subagent ${childConvId}`);
      return;
    }
    const text = buildSubagentNotification(childConvId, task, outcome, parent.maxChars ?? 6000);
    if (convStore.isStreaming(parent.convId)) {
      convStore.pushQueuedMessage(parent.convId, text, "next-turn");
      log("info", `handler: queued subagent completion notification ${childConvId} -> parent ${parent.convId}`);
      return;
    }
    log("info", `handler: sending subagent completion notification ${childConvId} -> parent ${parent.convId}`);
    void orchestrateSendMessage(
      server,
      null,
      undefined,
      parent.convId,
      text,
      Date.now(),
      buildOrchestrationCallbacks(parent.convId),
    ).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log("error", `handler: parent notification send failed for ${parent.convId}: ${msg}`);
    });
  };

  // ── Compact conversation payload helpers ─────────────────────────

  const compactImageForHistory = (image: ImageAttachment): ImageAttachment => ({
    mediaType: image.mediaType,
    base64: "",
    sizeBytes: image.sizeBytes,
  });

  const compactHistoryImages = (data: ConversationRenderSnapshot): ConversationRenderSnapshot => ({
    ...data,
    entries: data.entries.map((entry, index) => entry.type === "user"
      && entry.images?.length
      && index < data.entries.length - RECENT_HISTORY_IMAGE_PAYLOAD_ENTRIES
      ? { ...entry, images: entry.images.map(compactImageForHistory) }
      : entry),
  });

  const sendCompactHistoryUpdated = (convId: string): boolean => {
    const data = getRenderSnapshot(convId);
    if (!data) return false;
    const compactData = compactHistoryImages(data);
    server.sendToSubscribers(convId, {
      type: "history_updated",
      convId,
      entries: compactData.entries,
      contextTokens: compactData.contextTokens,
      toolOutputsIncluded: compactData.toolOutputsIncluded,
    });
    return true;
  };

  const sendCompactConversationLoaded = (target: ConnectedClient, convId: string, reqId?: string) => {
    const data = getRenderSnapshot(convId);
    if (!data) return null;
    const compactData = compactHistoryImages(data);
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
      entries: compactData.entries,
      ...(compactData.pendingAI ? { pendingAI: compactData.pendingAI } : {}),
      contextTokens: compactData.contextTokens,
      toolOutputsIncluded: compactData.toolOutputsIncluded,
      queuedMessages: queued.length > 0 ? queued : undefined,
      goal: conv?.goal ?? null,
    });
    return data;
  };

  const sendGoalUpdated = (convId: string, reqId: string | undefined, message?: string) => {
    const goal = convStore.get(convId)?.goal ?? null;
    server.sendToSubscribers(convId, { type: "goal_updated", reqId, convId, goal, message });
    broadcastConversationUpdated(server, convId);
    return goal;
  };

  const isSafeClientConversationId = (id: string): boolean => /^\d+-[a-z0-9]{6}$/.test(id);

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

      // ── Conversation lifecycle commands ───────────────────────────

      case "new_conversation": {
        const id = cmd.convId ?? convStore.generateId();
        if (cmd.convId && (!isSafeClientConversationId(cmd.convId) || convStore.get(cmd.convId))) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: "Invalid or duplicate client-supplied conversation id" });
          break;
        }
        const provider = cmd.provider ?? getDefaultProvider().id;
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
        const model = cmd.model ?? getDefaultModel(provider);
        const effort = normalizeEffort(provider, model, cmd.effort);
        const fastMode = cmd.fastMode === true;
        if (fastMode && !supportsFastMode(provider)) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: id, message: `Fast mode is only available for ${provider} conversations that support it.` });
          break;
        }
        const initialMessage = cmd.initialMessage;
        const goalObjective = cmd.goalObjective?.trim();
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

        const title = cmd.title ?? (initialMessage || goalObjective ? PENDING_TITLE : undefined);
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
        const goal = goalObjective ? setConversationGoal(id, goalObjective).goal : null;
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
          server.sendToSubscribers(id, { type: "goal_updated", reqId: cmd.reqId, convId: id, goal, message: `Goal set: ${goalObjective}` });
          startTitleGeneration(server, id, { extraContext: goalObjective });
          void orchestrateGoalContinuation(server, id, buildOrchestrationCallbacks(id)).catch((err) => {
            log("error", `handler: initial new-conversation goal continuation failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
          });
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
          const goal = convStore.get(cmd.convId)?.goal;
          if (cmd.reason !== "daemon-restart" && goal?.status === "active") {
            const result = applyUserGoalAction(convStore.get(cmd.convId)!, "pause");
            server.sendToSubscribers(cmd.convId, { type: "goal_updated", convId: cmd.convId, goal: result.goal });
          }
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
        if (!conv || conv.provider !== "openai" || convStore.isStreaming(cmd.convId)) break;
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
          const result = applyUserGoalAction(conv, "set", objective);
          const goal = sendGoalUpdated(cmd.convId, cmd.reqId, result.message);
          log("info", `handler: set goal for ${cmd.convId}: "${objective.slice(0, 80)}"`);
          if (goal?.status === "active") {
            void orchestrateGoalContinuation(server, cmd.convId, buildOrchestrationCallbacks(cmd.convId)).catch((err) => {
              log("error", `handler: initial goal continuation failed for ${cmd.convId}: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
          break;
        }

        if (cmd.action === "resume") {
          const result = applyUserGoalAction(conv, "resume");
          const goal = sendGoalUpdated(cmd.convId, cmd.reqId, result.message);
          if (goal?.status === "active" && !convStore.isStreaming(cmd.convId)) {
            void orchestrateGoalContinuation(server, cmd.convId, buildOrchestrationCallbacks(cmd.convId)).catch((err) => {
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
          if (cmd.notifyParent) ensureConversationInSubagentsFolder(cmd.convId);
          server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
          const turn = orchestrateSendMessage(
            server, null, undefined, cmd.convId, cmd.text, cmd.startedAt, callbacks, cmd.images,
          );
          maybeStartAutoTitleGeneration(cmd.convId);
          void turn.then((outcome) => {
            if (cmd.notifyParent) deliverParentNotification(cmd.notifyParent, cmd.convId, cmd.text, outcome);
          }).catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            log("error", `handler: detached send failed for ${cmd.convId}: ${message}`);
            if (cmd.notifyParent) {
              deliverParentNotification(cmd.notifyParent, cmd.convId, cmd.text, {
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
        );
        maybeStartAutoTitleGeneration(cmd.convId);
        await outcome;
        break;
      }

      case "replay_conversation": {
        await orchestrateReplayConversation(
          server, client, cmd.reqId, cmd.convId, cmd.startedAt,
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
        const nextProvider = cmd.provider ?? conv.provider;
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
          sendCompactHistoryUpdated(cmd.convId);
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
        const restored = convStore.undoDelete();
        if (restored?.type === "conversation") {
          const summary = convStore.getSummary(restored.conversation.id);
          if (summary) {
            log("info", `handler: restored conversation ${restored.conversation.id} from trash`);
            server.broadcast({ type: "conversation_restored", reqId: cmd.reqId, summary });
            server.broadcast({ type: "conversation_moved", ...convStore.listSidebarState() });
          }
        } else if (restored?.type === "sidebar_state") {
          server.broadcast({ type: "conversation_moved", ...convStore.listSidebarState() });
        } else {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: "Nothing to undo" });
        }
        break;
      }

      // ── Queue/system/history commands ─────────────────────────────

      case "queue_message": {
        convStore.pushQueuedMessage(cmd.convId, cmd.text, cmd.timing, cmd.images);
        server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
        log("info", `handler: queued ${cmd.timing} message for ${cmd.convId}: "${cmd.text.slice(0, 50)}"`);
        break;
      }

      case "unqueue_message": {
        const ok = convStore.removeQueuedMessage(cmd.convId, cmd.text);
        server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
        if (ok) log("info", `handler: unqueued message for ${cmd.convId}: "${cmd.text.slice(0, 50)}"`);
        break;
      }

      case "set_system_instructions": {
        const ok = convStore.setSystemInstructions(cmd.convId, cmd.text);
        if (ok) {
          server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
          server.broadcast({ type: "system_instructions_updated", convId: cmd.convId, text: cmd.text });
          broadcastConversationUpdated(server, cmd.convId);
          // Rebuild display for subscribers so the TUI shows the instructions entry
          sendCompactHistoryUpdated(cmd.convId);
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
          server.broadcast({ type: "folder_instructions_updated", reqId: cmd.reqId, folderId: cmd.folderId, text: cmd.text.trim() });
          server.broadcast({ type: "conversation_moved", ...convStore.listSidebarState() });
          for (const convId of convStore.listFolderConversationIds(cmd.folderId)) {
            sendCompactHistoryUpdated(convId);
          }
          log("info", `handler: folder instructions ${cmd.text.trim() ? "set" : "cleared"} for ${cmd.folderId}`);
        } else {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Folder ${cmd.folderId} not found` });
        }
        break;
      }

      case "unwind_conversation": {
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
        sendCompactHistoryUpdated(cmd.convId);
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
        const data = sendCompactConversationLoaded(client, cmd.convId, cmd.reqId);
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
              tokens: pendingAI.metadata?.tokens ?? 0,
            });
          }
        }
        // Clear unread when a client views the conversation
        if (convStore.clearUnread(data.convId)) {
          broadcastConversationUpdated(server, data.convId);
        }
        break;
      }

      // ── Utility/tool/auth commands ────────────────────────────────

      case "get_system_prompt": {
        const instructions = cmd.convId ? convStore.getSystemInstructions(cmd.convId) : null;
        server.sendTo(client, {
          type: "system_prompt",
          reqId: cmd.reqId,
          systemPrompt: buildSystemPrompt(instructions ?? undefined),
        });
        break;
      }

      case "llm_complete": {
        const provider = cmd.provider ?? getDefaultProvider().id;
        if (!getProvider(provider)) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Unknown provider: ${provider}` });
          break;
        }
        const model = cmd.model ?? getDefaultModel(provider);
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
          if (cmd.action === "remove") {
            Promise.resolve().then(() => removeOpenAIAccount(cmd.target)).then((removed) => {
              invalidateCredentialsCache("openai");
              const label = removed.email ?? removed.displayName ?? removed.accountId ?? `#${removed.index}`;
              server.sendTo(client, { type: "auth_status", reqId: cmd.reqId, message: `Removed OpenAI account ${label}.\n\n${formatOpenAIAccountList()}` });
              broadcastToolsAvailable();
              refreshUsage(provider, (usage) => broadcastUsage(provider, usage));
            }).catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              log("error", `handler: openai account remove failed: ${msg}`);
              server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `OpenAI account remove failed: ${msg}` });
            });
            break;
          }

          if (cmd.action === "add") {
            addOpenAIAccount({
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
                  message: `Paste this URL into a browser to add an OpenAI account:\n\n${url}`,
                });
                return true;
              },
            }).then((result) => {
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
            });
            break;
          }

          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Unsupported OpenAI login action: ${cmd.action}` });
          break;
        }

        ensureAuthenticated(provider, {
          onProgress: (msg) => {
            server.sendTo(client, { type: "auth_status", reqId: cmd.reqId, message: msg });
          },
          onOpenUrl: (url) => {
            server.sendTo(client, { type: "auth_status", reqId: cmd.reqId, openUrl: url });
            return true;
          },
        }, cmd.apiKey ? { apiKey: cmd.apiKey } : undefined).then(({ status, email }) => {
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

        Promise.resolve().then(() => switchOpenAIAccount(cmd.target)).then((switched) => {
          invalidateCredentialsCache("openai");
          const label = switched.email ?? switched.displayName ?? switched.accountId ?? `account-${switched.index}`;
          server.sendTo(client, { type: "auth_status", reqId: cmd.reqId, message: `Switched OpenAI account to ${label}.\n\n${formatOpenAIAccountList()}` });
          broadcastToolsAvailable();
          refreshUsage(provider, (usage) => broadcastUsage(provider, usage));
        }).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          log("error", `handler: openai account switch failed: ${msg}`);
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `OpenAI account switch failed: ${msg}` });
        });
        break;
      }

      case "logout": {
        const provider = cmd.provider ?? getDefaultProvider().id;
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
