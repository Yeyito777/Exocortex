/**
 * What Claude Code calls the program that started it (`CLAUDE_CODE_ENTRYPOINT`).
 * By default the Agent SDK's own label; Exocortex's only with
 * `providers.anthropic.customEntrypoint`. See docs/anthropic.md#entrypoint.
 */

import { readExocortexConfig } from "@exocortex/shared/config";

export const CLAUDE_CODE_ENTRYPOINT = "exocortex";
/** The Agent SDK's own label, which it sets when the variable is unset. */
export const AGENT_SDK_ENTRYPOINT = "sdk-ts";

function customEntrypointEnabled(): boolean {
  return readExocortexConfig().providers?.anthropic?.customEntrypoint === true;
}

/**
 * Environment that labels a subscription process, empty unless the custom
 * entrypoint is on. Claude Code turns on some things for any label but `sdk-*`
 * (Artifact tools and the scratchpad, feedback drafts), so this keeps them off,
 * as under the SDK's label.
 */
export function claudeEntrypointEnv(): Record<string, string> {
  if (!customEntrypointEnabled()) return {};
  return { CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_ARTIFACT: "0", CLAUDE_CODE_SEND_FEEDBACK: "0" };
}

/** Settings for the same purpose: automatic memory consolidation, which has no environment switch. */
export function claudeEntrypointSettings(): { autoDreamEnabled: false } | null {
  return customEntrypointEnabled() ? { autoDreamEnabled: false } : null;
}

/**
 * The User-Agent of a /proxy request signed with an API-credit key. Credit-only
 * organizations refuse a request with no `sdk-*` label ("credit balance is too
 * low"), and the machine that sent it could not know how it would be billed.
 */
export function agentSdkUserAgent(userAgent: string): string {
  return userAgent.replace(`(external, ${CLAUDE_CODE_ENTRYPOINT}`, `(external, ${AGENT_SDK_ENTRYPOINT}`);
}
