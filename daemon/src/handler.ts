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
import { orchestrateSendMessage } from "./orchestrator";
import { complete } from "./llm";
import { buildSystemPrompt } from "./system";
import { getToolDisplayInfo } from "./tools/registry";
import { getExternalToolStyles } from "./external-tools";
import { EFFORT_LEVELS } from "./messages";
import { getDefaultProvider, getDefaultModel, getProvider, getProviders, isKnownModel, allowsCustomModels, refreshProviders, normalizeEffort, supportsEffort, getSupportedEfforts, supportsFastMode } from "./providers/registry";
import * as convStore from "./conversations";
import { DaemonServer, type ConnectedClient } from "./server";
import type { Command } from "./protocol";
import { clearAuth, ensureAuthenticated, hasConfiguredCredentials } from "./auth";

// ── Handler ─────────────────────────────────────────────────────────

export function createHandler(server: DaemonServer) {
  const broadcastUsage = (provider: import("./messages").ProviderId, usage: import("./messages").UsageData | null) => {
    server.broadcast({ type: "usage_update", provider, usage });
  };
  const broadcastToolsAvailable = () => {
    const externalStyles = getExternalToolStyles();
    server.broadcast({
      type: "tools_available",
      providers: getProviders(),
      tools: getToolDisplayInfo(),
      ...(externalStyles.length > 0 ? { externalToolStyles: externalStyles } : {}),
    });
  };

  return async function handleCommand(client: ConnectedClient, cmd: Command): Promise<void> {
    switch (cmd.type) {

      case "ping": {
        server.sendTo(client, { type: "pong", reqId: cmd.reqId });
        const externalStyles = getExternalToolStyles();
        server.sendTo(client, {
          type: "tools_available",
          providers: getProviders(),
          tools: getToolDisplayInfo(),
          ...(externalStyles.length > 0 ? { externalToolStyles: externalStyles } : {}),
        });
        for (const provider of getProviders()) {
          const lastUsage = getLastUsage(provider.id);
          server.sendTo(client, { type: "usage_update", provider: provider.id, usage: lastUsage });
        }
        server.sendTo(client, { type: "conversations_list", conversations: convStore.listSummaries() });
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

      case "new_conversation": {
        const id = convStore.generateId();
        const provider = cmd.provider ?? getDefaultProvider().id;
        const providerInfo = getProvider(provider);
        if (!providerInfo) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Unknown provider: ${provider}` });
          break;
        }
        const model = cmd.model && (isKnownModel(provider, cmd.model) || allowsCustomModels(provider))
          ? cmd.model
          : getDefaultModel(provider);
        const effort = normalizeEffort(provider, model, cmd.effort);
        const fastMode = cmd.fastMode === true;
        if (fastMode && !supportsFastMode(provider)) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `Fast mode is only available for ${provider} conversations that support it.` });
          break;
        }
        convStore.create(id, provider, model, cmd.title, effort, fastMode);
        log("info", `handler: created conversation ${id} (provider=${provider}, model=${model}, fastMode=${fastMode}, title="${cmd.title ?? ""}")`);

        server.sendTo(client, {
          type: "conversation_created",
          reqId: cmd.reqId,
          convId: id,
          provider,
          model,
          effort,
          fastMode,
        });
        server.broadcast({ type: "conversation_updated", summary: convStore.getSummary(id)! });
        break;
      }

      case "subscribe": {
        server.subscribe(client, cmd.convId);
        // Clear unread when a client views the conversation
        if (convStore.clearUnread(cmd.convId)) {
          server.broadcast({ type: "conversation_updated", summary: convStore.getSummary(cmd.convId)! });
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
          ac.abort();
          log("info", `handler: abort requested for ${cmd.convId}`);
        }
        server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
        break;
      }

      case "send_message": {
        await orchestrateSendMessage(
          server, client, cmd.reqId, cmd.convId, cmd.text, cmd.startedAt,
          {
            onHeaders: (h) => {
              const provider = convStore.get(cmd.convId)?.provider ?? getDefaultProvider().id;
              handleUsageHeaders(provider, h, (usage) => broadcastUsage(provider, usage));
            },
            onComplete: () => {
              const provider = convStore.get(cmd.convId)?.provider ?? getDefaultProvider().id;
              refreshUsage(provider, (usage) => broadcastUsage(provider, usage));
            },
          },
          cmd.images,
        );
        break;
      }

      case "set_model": {
        const conv = convStore.get(cmd.convId);
        if (!conv) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
          break;
        }
        if (!isKnownModel(conv.provider, cmd.model) && !allowsCustomModels(conv.provider)) {
          server.sendTo(client, {
            type: "error",
            reqId: cmd.reqId,
            convId: cmd.convId,
            message: `Unknown model for provider ${conv.provider}: ${cmd.model}`,
          });
          break;
        }
        const nextEffort = normalizeEffort(conv.provider, cmd.model, conv.effort);
        const ok = convStore.setModel(cmd.convId, cmd.model, nextEffort);
        if (ok) {
          server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
          server.broadcast({ type: "conversation_updated", summary: convStore.getSummary(cmd.convId)! });
          log("info", `handler: model set to ${cmd.model} for ${cmd.convId} (effort=${nextEffort})`);
        } else {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
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
          server.broadcast({ type: "conversation_updated", summary: convStore.getSummary(cmd.convId)! });
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
          server.broadcast({ type: "conversation_updated", summary: convStore.getSummary(cmd.convId)! });
          log("info", `handler: fast mode ${cmd.enabled ? "enabled" : "disabled"} for ${cmd.convId}`);
        } else {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
        }
        break;
      }

      case "list_conversations": {
        const conversations = convStore.listSummaries();
        server.sendTo(client, { type: "conversations_list", reqId: cmd.reqId, conversations });
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
          server.broadcast({ type: "conversation_moved", conversations: convStore.listSummaries() });
        }
        break;
      }

      case "move_conversation": {
        const ok = convStore.move(cmd.convId, cmd.direction);
        if (ok) {
          server.broadcast({ type: "conversation_moved", conversations: convStore.listSummaries() });
        }
        break;
      }

      case "rename_conversation": {
        const ok = convStore.rename(cmd.convId, cmd.title);
        if (ok) {
          server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
          server.broadcast({ type: "conversation_updated", summary: convStore.getSummary(cmd.convId)! });
          log("info", `handler: renamed conversation ${cmd.convId} to "${cmd.title}"`);
        } else {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
        }
        break;
      }

      case "clone_conversation": {
        const cloned = convStore.clone(cmd.convId);
        if (cloned) {
          const summary = convStore.getSummary(cloned.id);
          if (summary) {
            log("info", `handler: cloned conversation ${cmd.convId} → ${cloned.id}`);
            server.broadcast({ type: "conversation_restored", reqId: cmd.reqId, summary });
            server.broadcast({ type: "conversation_moved", conversations: convStore.listSummaries() });
          }
        } else {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
        }
        break;
      }

      case "undo_delete": {
        const restored = convStore.undoDelete();
        if (restored) {
          const summary = convStore.getSummary(restored.id);
          if (summary) {
            log("info", `handler: restored conversation ${restored.id} from trash`);
            server.broadcast({ type: "conversation_restored", reqId: cmd.reqId, summary });
            server.broadcast({ type: "conversation_moved", conversations: convStore.listSummaries() });
          }
        } else {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: "Nothing to undo" });
        }
        break;
      }

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
          server.broadcast({ type: "conversation_updated", summary: convStore.getSummary(cmd.convId)! });
          // Rebuild display for subscribers so the TUI shows the instructions entry
          const data = convStore.getDisplayData(cmd.convId);
          if (data) {
            server.sendToSubscribers(cmd.convId, {
              type: "history_updated",
              convId: cmd.convId,
              entries: data.entries,
              contextTokens: data.contextTokens,
            });
          }
          log("info", `handler: system instructions ${cmd.text ? "set" : "cleared"} for ${cmd.convId}`);
        } else {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
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
        // Respond with the truncated state (reuse conversation_loaded)
        const data = convStore.getDisplayData(cmd.convId);
        if (data) {
          server.sendTo(client, {
            type: "conversation_loaded",
            reqId: cmd.reqId,
            convId: data.convId,
            provider: data.provider,
            model: data.model,
            effort: data.effort,
            fastMode: data.fastMode,
            entries: data.entries,
            contextTokens: data.contextTokens,
          });
        }
        server.broadcast({ type: "conversation_updated", summary: convStore.getSummary(cmd.convId)! });
        break;
      }

      case "load_conversation": {
        const data = convStore.getDisplayData(cmd.convId);
        if (!data) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
          break;
        }
        const queued = convStore.getQueuedMessages(data.convId);
        server.sendTo(client, {
          type: "conversation_loaded",
          reqId: cmd.reqId,
          convId: data.convId,
          provider: data.provider,
          model: data.model,
          effort: data.effort,
          fastMode: data.fastMode,
          entries: data.entries,
          contextTokens: data.contextTokens,
          queuedMessages: queued.length > 0 ? queued : undefined,
        });
        server.subscribe(client, data.convId);
        // If the conversation is actively streaming, tell the late-joining client
        // so it creates pendingAI and picks up future chunks.
        if (convStore.isStreaming(data.convId)) {
          server.sendTo(client, {
            type: "streaming_started",
            convId: data.convId,
            provider: data.provider,
            model: data.model,
            startedAt: convStore.getStreamingStartedAt(data.convId) ?? Date.now(),
            blocks: convStore.getCurrentStreamingBlocks(data.convId) ?? [],
            tokens: convStore.getStreamingTokens(data.convId),
          });
        }
        // Clear unread when a client views the conversation
        if (convStore.clearUnread(data.convId)) {
          server.broadcast({ type: "conversation_updated", summary: convStore.getSummary(data.convId)! });
        }
        break;
      }

      case "get_system_prompt": {
        const instructions = cmd.convId ? convStore.getSystemInstructions(cmd.convId) : null;
        server.sendTo(client, { type: "system_prompt", reqId: cmd.reqId, systemPrompt: buildSystemPrompt(instructions ?? undefined) });
        break;
      }

      case "llm_complete": {
        const provider = cmd.provider ?? getDefaultProvider().id;
        const model = cmd.model ?? getDefaultModel(provider);
        // Default must exceed the thinking budget (10000) for non-adaptive
        // models, otherwise all tokens go to thinking and text is empty.
        const maxTokens = cmd.maxTokens ?? 16000;
        log("info", `handler: llm_complete (provider=${provider}, model=${model}, maxTokens=${maxTokens}, input=${cmd.userText.length} chars)`);

        // Fire-and-forget — ack immediately, send result when ready
        server.sendTo(client, { type: "ack", reqId: cmd.reqId });

        complete(cmd.system, cmd.userText, { provider, model, maxTokens })
          .then((result) => {
            server.sendTo(client, { type: "llm_complete_result", reqId: cmd.reqId, text: result.text });
          })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            log("error", `handler: llm_complete failed: ${msg}`);
            server.sendTo(client, { type: "error", reqId: cmd.reqId, message: `llm_complete failed: ${msg}` });
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
        ensureAuthenticated(provider, {
          onProgress: (msg) => {
            server.sendTo(client, { type: "auth_status", reqId: cmd.reqId, message: msg });
          },
          onOpenUrl: (url) => {
            server.sendTo(client, { type: "auth_status", reqId: cmd.reqId, message: "Opening browser for authentication…", openUrl: url });
          },
        }).then(({ status, email }) => {
          const label = email ?? provider;
          server.sendTo(client, { type: "auth_status", reqId: cmd.reqId, message: statusMessages[status](label) });
          log("info", `handler: login ${status} (${label})`);
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

      case "logout": {
        const provider = cmd.provider ?? getDefaultProvider().id;
        clearAuth(provider);
        clearUsage(provider);
        broadcastUsage(provider, null);
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
