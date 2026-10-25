/**
 * What a subagent is still waiting on when one of its turns ends: its running
 * background tasks and subagents, one-shot wakes it scheduled, and input
 * already queued for it. Each of these wakes it again later, so its parent's
 * notice says the child is not done yet. A repeating wake never ends, so it
 * does not count.
 */

import { listChronoSchedules } from "./chrono-service";
import { getConversationTasks } from "./conversation-activity";
import * as convStore from "./conversations";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function titles(items: { title: string }[]): string {
  const shown = items.slice(0, 3).map(item => item.title.replace(/\s+/g, " ").trim().slice(0, 60)).filter(Boolean);
  if (shown.length === 0) return "";
  return ` (${shown.join("; ")}${items.length > shown.length ? "; …" : ""})`;
}

function inMinutes(dueAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((dueAt - now) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 120) return `in ${minutes} min`;
  return `in ${Math.round(minutes / 60)} h`;
}

/** One line per kind of pending work, empty when the child is done. */
export function describeSubagentPendingWork(convId: string, now = Date.now()): string[] {
  const tasks = getConversationTasks(convId);
  const background = tasks.filter(task => task.kind === "background");
  const subagents = tasks.filter(task => task.kind === "subagent");
  const wakes = listChronoSchedules(convId)
    .filter(schedule => !schedule.recurrence && (
      schedule.target.kind === "conversation" || schedule.target.hardWake !== undefined
    ));
  const queued = convStore.getQueuedMessages(convId).length;
  const lines: string[] = [];
  if (background.length > 0) lines.push(`${plural(background.length, "background task")}${titles(background)}`);
  if (subagents.length > 0) lines.push(`${plural(subagents.length, "subagent")}${titles(subagents)}`);
  if (wakes.length > 0) {
    lines.push(`${plural(wakes.length, "scheduled wake")} (next ${inMinutes(Math.min(...wakes.map(wake => wake.nextAt)), now)})`);
  }
  if (queued > 0) lines.push(plural(queued, "queued message"));
  return lines;
}
