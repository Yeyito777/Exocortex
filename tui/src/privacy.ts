/**
 * Privacy/censoring helpers for user-identifying strings in the TUI.
 */

import type { ProviderAuthAccountInfo } from "./protocol";
import type { RenderState } from "./state";
import { readExocortexConfig, updateExocortexConfig } from "@exocortex/shared/config";

export function loadHideSensitiveInfoPreference(): boolean {
  return readExocortexConfig().tui?.hideSensitiveInfo === true;
}

export function saveHideSensitiveInfoPreference(enabled: boolean): void {
  updateExocortexConfig((config) => {
    config.tui = { ...(config.tui ?? {}), hideSensitiveInfo: enabled };
  });
}

export function isEmailLike(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function censorEmail(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const trimmed = value.trim();
  if (!isEmailLike(trimmed)) return "******";
  const at = trimmed.indexOf("@");
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const first = local[0] ?? "*";
  return `${first}${"*".repeat(Math.max(1, local.length - 1))}@${domain}`;
}

export function maybeCensorEmail(value: string | null | undefined, hidden: boolean): string | null {
  if (!value?.trim()) return null;
  return hidden ? censorEmail(value) : value.trim();
}

export function accountDisplayLabel(
  state: Pick<RenderState, "hideSensitiveInfo">,
  account: Pick<ProviderAuthAccountInfo, "email" | "displayName" | "accountId"> | null | undefined,
  fallback = "unknown",
): string {
  if (!account) return fallback;
  const email = account.email?.trim() || null;
  if (email) return maybeCensorEmail(email, state.hideSensitiveInfo) ?? fallback;
  return account.displayName?.trim() || account.accountId?.trim() || fallback;
}

export function autocompleteAccountLabel(
  state: Pick<RenderState, "hideSensitiveInfo">,
  account: Pick<ProviderAuthAccountInfo, "email" | "displayName" | "accountId">,
  index: number,
): string {
  const email = account.email?.trim() || null;
  if (state.hideSensitiveInfo && email) return censorEmail(email) ?? String(index + 1);
  return email || account.displayName?.trim() || account.accountId?.trim() || String(index + 1);
}

export function censorKnownAuthEmails(state: RenderState, text: string): string {
  if (!state.hideSensitiveInfo) return text;
  const emails = new Set<string>();
  for (const info of Object.values(state.authInfoByProvider)) {
    if (info.email?.trim()) emails.add(info.email.trim());
    for (const account of info.accounts ?? []) {
      if (account.email?.trim()) emails.add(account.email.trim());
    }
    if (info.currentAccount?.email?.trim()) emails.add(info.currentAccount.email.trim());
  }

  let out = text;
  for (const email of emails) {
    out = out.replaceAll(email, censorEmail(email) ?? "••••••");
  }
  return out.replace(/[^\s<>"']+@[^\s<>"']+\.[^\s<>"']+/g, (email) => censorEmail(email) ?? "******");
}
