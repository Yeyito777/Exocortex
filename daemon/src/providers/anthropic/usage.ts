/**
 * Claude Code-backed Anthropic usage handling.
 *
 * Claude Code does not expose the OAuth usage endpoints used by the old
 * backend, so the daemon currently treats Anthropic usage as unavailable.
 */

import type { UsageData } from "../../messages";

export function getLastUsage(): UsageData | null {
  return null;
}

export function clearUsage(): void {
  return;
}

export function refreshUsage(_onUpdate: (usage: UsageData) => void): void {
  return;
}

export function handleUsageHeaders(_headers: Headers, _onUpdate: (usage: UsageData) => void): void {
  return;
}
