/** Text for `/account claude`: each account's sign-in, limits and usage, then the combined bars' numbers. */

import { homedir } from "os";
import type { UsageData, UsageWindow } from "../../messages";
import { claudeLoginCommand, MAIN_ACCOUNT_ID } from "./accounts";
import type { ClaudeAccountReport } from "./account-pool";
import { isSubscriptionAuth } from "./cli";

function displayPath(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${mins < 10 ? "0" : ""}${mins}m`;
  return `${mins}m`;
}

function formatWindow(label: string, window: UsageWindow | null | undefined, now: number): string {
  if (!window) return `${label} ?`;
  if (window.resetsAt !== null && window.resetsAt <= now) return `${label} 0%`;
  const reset = window.resetsAt !== null ? ` (resets in ${formatDuration(window.resetsAt - now)})` : "";
  return `${label} ${Math.round(window.utilization)}%${reset}`;
}

function formatState(report: ClaudeAccountReport, now: number): string {
  if (report.block) return `blocked: ${report.block.reason} (checked again in ${formatDuration(report.block.until - now)})`;
  if (!report.status) return "not checked";
  if (!report.status.loggedIn) return "signed out";
  if (!isSubscriptionAuth(report.status)) return `signed in with ${report.status.authMethod ?? "an unknown method"}, not a Claude subscription`;
  if (report.limited) {
    return report.limitedUntil !== null ? `at a usage limit (for ${formatDuration(report.limitedUntil - now)})` : "at a usage limit";
  }
  return "ready";
}

function formatAccount(report: ClaudeAccountReport, now: number): string[] {
  const { account, status } = report;
  const who = [status?.email, status?.subscriptionType].filter(Boolean).join(" · ");
  const lines = [`  ${account.id}${who ? ` — ${who}` : ""} — ${formatState(report, now)}`];
  lines.push(`      ${account.id === MAIN_ACCOUNT_ID ? "Claude Code's own login" : "config"}: ${displayPath(account.configDir)}`);
  if (report.available) {
    const activity = [
      report.activeTurns > 0 ? `${report.activeTurns} turn${report.activeTurns === 1 ? "" : "s"} running` : null,
      report.conversations > 0 ? `${report.conversations} conversation${report.conversations === 1 ? "" : "s"} with a warm cache` : null,
    ].filter(Boolean).join(", ");
    lines.push(`      ${formatWindow("5-hour", report.usage?.fiveHour, now)} · ${formatWindow("weekly", report.usage?.sevenDay, now)}${activity ? ` · ${activity}` : ""}`);
  } else if (!report.block && (!status || !status.loggedIn || !isSubscriptionAuth(status))) {
    lines.push(`      sign in from a terminal: ${claudeLoginCommand(account)}`);
  }
  return lines;
}

function formatCombined(usage: UsageData | null): string | null {
  if (!usage?.capacity) return null;
  const part = (label: string, window: UsageWindow | null) =>
    `${label} ${window ? Math.round(window.utilization) : "?"}/${usage.capacity}%`;
  return `Combined (the usage bars): ${part("5-hour", usage.fiveHour)} · ${part("weekly", usage.sevenDay)}`;
}

export function formatClaudeAccountReports(reports: ClaudeAccountReport[], combined: UsageData | null, now = Date.now()): string {
  const lines = ["Claude accounts:"];
  for (const report of reports) lines.push(...formatAccount(report, now));
  const total = formatCombined(combined);
  if (total) lines.push("", total);
  lines.push(
    "",
    reports.length > 1
      ? "Exocortex picks the account for each conversation: it stays on its account while its prompt cache is warm, and new work goes to the account whose capacity expires soonest."
      : "Add another Claude account with /account claude add <name>.",
  );
  return lines.join("\n");
}
