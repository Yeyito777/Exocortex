/** Ephemeral tool choices for a client-reserved, not-yet-created conversation. */

import type { ConversationToolPolicy } from "./messages";
import { clearConversationCustomTools } from "./tools/custom-tools";

const drafts = new Map<string, ConversationToolPolicy>();

function clonePolicy(policy: ConversationToolPolicy): ConversationToolPolicy {
  return {
    internal: [...policy.internal],
    external: [...policy.external],
    ...(policy.customToolModules?.length ? {
      customToolModules: policy.customToolModules.map((module) => ({
        ...module,
        tools: module.tools.map((tool) => ({ ...tool })),
      })),
    } : {}),
  };
}

export function getDraftToolPolicy(draftId: string): ConversationToolPolicy | null {
  const policy = drafts.get(draftId);
  return policy ? clonePolicy(policy) : null;
}

export function setDraftToolPolicy(draftId: string, policy: ConversationToolPolicy): void {
  drafts.set(draftId, clonePolicy(policy));
}

/** Consume without disposing: the runtime already uses the future conversation id. */
export function takeDraftToolPolicy(draftId: string): ConversationToolPolicy | null {
  const policy = drafts.get(draftId);
  if (!policy) return null;
  drafts.delete(draftId);
  return clonePolicy(policy);
}

export async function clearDraftToolPolicy(draftId: string): Promise<void> {
  drafts.delete(draftId);
  await clearConversationCustomTools(draftId);
}

export const draftToolPolicyInternalsForTest = {
  count: () => drafts.size,
};
