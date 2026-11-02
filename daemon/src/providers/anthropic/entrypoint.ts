/**
 * What Claude Code calls the program that started it (`CLAUDE_CODE_ENTRYPOINT`).
 * See docs/anthropic.md#entrypoint.
 */

import { readExocortexConfig } from "@exocortex/shared/config";

export const CLAUDE_CODE_ENTRYPOINT = "exocortex";
/** The Agent SDK's own label, which it sets when the variable is unset. */
export const AGENT_SDK_ENTRYPOINT = "sdk-ts";

/**
 * Environment that labels a subscription process, empty with
 * `providers.anthropic.sdkEntrypoint`. Claude Code turns on some things for
 * any label but `sdk-*` (Artifact tools and the scratchpad, feedback drafts),
 * so this keeps them off, as under the SDK's label.
 */
export function claudeEntrypointEnv(): Record<string, string> {
  if (readExocortexConfig().providers?.anthropic?.sdkEntrypoint === true) return {};
  return { CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_ARTIFACT: "0", CLAUDE_CODE_SEND_FEEDBACK: "0" };
}

/** Settings for the same purpose: automatic memory consolidation, which has no environment switch. */
export function claudeEntrypointSettings(): { autoDreamEnabled: false } | null {
  return readExocortexConfig().providers?.anthropic?.sdkEntrypoint === true ? null : { autoDreamEnabled: false };
}

/**
 * The User-Agent of a /proxy request signed with an API-credit key. Credit-only
 * organizations refuse a request with no `sdk-*` label ("credit balance is too
 * low"), and the machine that sent it could not know how it would be billed.
 */
export function agentSdkUserAgent(userAgent: string): string {
  return userAgent.replace(`(external, ${CLAUDE_CODE_ENTRYPOINT}`, `(external, ${AGENT_SDK_ENTRYPOINT}`);
}
