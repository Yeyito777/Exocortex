/**
 * OpenAI account status block — shown only when multiple OpenAI accounts are connected.
 */

import type { RenderState } from "../state";
import type { StatusBlock } from "../statusline";
import { theme } from "../theme";

function displayAccount(email: string | null | undefined, displayName: string | null | undefined): string {
  return email?.trim() || displayName?.trim() || "unknown";
}

function displayPlan(plan: string | null | undefined): string {
  return plan?.trim() || "unknown";
}

export function openAIAccountBlock(state: RenderState): StatusBlock | null {
  if (state.provider !== "openai") return null;

  const info = state.authInfoByProvider.openai;
  const accounts = info.accounts ?? [];
  if (accounts.length <= 1) return null;

  const current = info.currentAccount ?? accounts.find((account) => account.current) ?? null;
  const account = displayAccount(current?.email, current?.displayName);
  const plan = displayPlan(current?.subscriptionType);
  const accountLabel = "Account: ";
  const planLabel = "Plan: ";
  const width = Math.max(accountLabel.length + account.length, planLabel.length + plan.length);

  return {
    id: "openai-account",
    priority: 2,
    width,
    height: 2,
    rows: [
      `${theme.muted}${accountLabel}${theme.accent}${account}${theme.reset}${" ".repeat(Math.max(0, width - accountLabel.length - account.length))}`,
      `${theme.muted}${planLabel}${theme.accent}${plan}${theme.reset}${" ".repeat(Math.max(0, width - planLabel.length - plan.length))}`,
    ],
  };
}
