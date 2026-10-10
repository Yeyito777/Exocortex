import type { Conversation } from "./messages";
import { scopedSubagentPromptOptions } from "./subagent-policy";
import { buildClaudeCodeSystemAppend, buildSystemPrompt } from "./system";
import { getConversationToolNames, getToolDefs } from "./tools/registry";
import { getModelInfo } from "./providers/registry";

/**
 * Build the cache-sensitive model surface for an ordinary conversation turn.
 *
 * Keeping this in one place ensures auxiliary branches such as `/btw` can send
 * byte-for-byte equivalent instructions and tool schemas for the shared prefix.
 */
export function buildConversationRequestSurface(
  conversation: Conversation,
  options: {
    conversationId: string;
    workingDirectory: string;
    conversationInstructions?: string;
    subagentMaxDepth?: number | null;
  },
) {
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
      includeExternalToolHints: !chatOnly,
    }),
    tools: getToolDefs(toolNames, options.conversationId),
    toolNames,
  };
}
