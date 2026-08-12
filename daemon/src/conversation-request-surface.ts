import type { Conversation } from "./messages";
import { scopedSubagentPromptOptions } from "./subagent-policy";
import { buildSystemPrompt } from "./system";
import { resolveConversationToolPolicy } from "./tool-policy";
import { getToolDefs } from "./tools/registry";

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
  const resolvedToolPolicy = resolveConversationToolPolicy(conversation, subagentMaxDepth);
  const toolNames = resolvedToolPolicy.internalToolNames;
  return {
    system: buildSystemPrompt({
      conversationInstructions: options.conversationInstructions,
      conversationId: options.conversationId,
      workingDirectory: options.workingDirectory,
      subagentMaxDepth,
      ...(scopedPromptOptions ?? {}),
      toolNames,
      includeExternalToolHints: true,
      externalToolNames: resolvedToolPolicy.externalToolNames,
    }),
    tools: getToolDefs(toolNames, options.conversationId),
    toolNames,
  };
}
