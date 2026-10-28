import type { Conversation } from "./messages";
import { scopedSubagentPromptOptions } from "./subagent-policy";
import { buildAppAgentSystemPrompt, buildClaudeCodeSystemAppend, buildSystemPrompt } from "./system";
import { getConversationToolNames, getToolDefs } from "./tools/registry";
import { getModelInfo } from "./providers/registry";
import { getAppRecord, type AppConversationRecord } from "./app-registry";
import { appToolSurfaceDefs, resolveAppBuiltinTools } from "./app-tools";
import type { ClaudeCodeAppSurface } from "./providers/types";

interface RequestSurfaceOptions {
  conversationId: string;
  workingDirectory: string;
  conversationInstructions?: string;
  subagentMaxDepth?: number | null;
}

/**
 * Build the cache-sensitive model surface for an ordinary conversation turn.
 *
 * Keeping this in one place ensures auxiliary branches such as `/btw` can send
 * byte-for-byte equivalent instructions and tool schemas for the shared prefix.
 */
export function buildConversationRequestSurface(
  conversation: Conversation,
  options: RequestSurfaceOptions,
) {
  const app = getAppRecord(options.conversationId);
  if (app) return buildAppRequestSurface(conversation, app, options);
  const subagentMaxDepth = options.subagentMaxDepth ?? conversation.subagentMaxDepth ?? null;
  const scopedPromptOptions = scopedSubagentPromptOptions(conversation, subagentMaxDepth);
  const chatOnly = getModelInfo(conversation.provider, conversation.model)?.supportsTools === false;
  const toolNames = chatOnly ? [] : getConversationToolNames(conversation.provider);
  return {
    // Claude Code (anthropic) keeps its own prompt and tools; Exocortex only
    // appends its additions. State that changes during a conversation, such
    // as its goal, reaches the model as turn notices instead (turn-notices.ts).
    system: conversation.provider === "anthropic" ? buildClaudeCodeSystemAppend({
      conversationInstructions: options.conversationInstructions,
      ...(scopedPromptOptions ?? {}),
      includeExternalToolHints: !chatOnly,
    }) : buildSystemPrompt({
      conversationInstructions: options.conversationInstructions,
      conversationId: options.conversationId,
      workingDirectory: options.workingDirectory,
      subagentMaxDepth,
      ...(scopedPromptOptions ?? {}),
      toolNames,
      provider: conversation.provider,
      includeExternalToolHints: !chatOnly,
    }),
    tools: getToolDefs(toolNames, options.conversationId, conversation.provider),
    toolNames,
    claudeCodeApp: undefined as ClaudeCodeAppSurface | undefined,
  };
}

/**
 * An app conversation's surface (docs/app-api.md): its own system prompt on
 * the base it chose, the built-in tools it chose mapped to its provider's,
 * and its own tools.
 */
function buildAppRequestSurface(conversation: Conversation, app: AppConversationRecord, options: RequestSurfaceOptions) {
  const provider = conversation.provider;
  const builtin = resolveAppBuiltinTools(app.builtin, provider, { ephemeral: app.lifetime === "ephemeral" });
  const builtinNames = builtin.exocortexTools;
  const appDefs = appToolSurfaceDefs(app.appTools);
  const toolNames = [...builtinNames, ...app.appTools.map(tool => tool.name)];
  const tools = [...getToolDefs(builtinNames, options.conversationId, provider), ...appDefs];
  const text = app.system.text;
  const base = app.system.base;
  let system: string;
  if (base === "full") {
    // Exactly an ordinary conversation's prompt, with the app's text as its instructions.
    const conversationInstructions = [text, options.conversationInstructions].filter(Boolean).join("\n\n") || undefined;
    system = provider === "anthropic"
      ? buildClaudeCodeSystemAppend({ conversationInstructions, includeExternalToolHints: true })
      : buildSystemPrompt({
        conversationInstructions,
        conversationId: options.conversationId,
        workingDirectory: options.workingDirectory,
        subagentMaxDepth: null,
        toolNames: builtinNames,
        provider,
        includeExternalToolHints: true,
      });
  } else if (base === "agent" && provider !== "anthropic") {
    system = buildAppAgentSystemPrompt({
      conversationId: options.conversationId,
      workingDirectory: options.workingDirectory,
      toolNames: builtinNames,
      provider,
      text,
    });
  } else {
    // none, and agent under Claude Code (its preset supplies the rest).
    system = text;
  }
  const claudeCodeApp: ClaudeCodeAppSurface | undefined = provider === "anthropic" ? {
    base,
    ...(builtin.claudeCodeTools ? { tools: builtin.claudeCodeTools } : {}),
    appTools: appDefs,
    ephemeral: app.lifetime === "ephemeral",
  } : undefined;
  return { system, tools, toolNames, claudeCodeApp };
}
