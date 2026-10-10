/**
 * `/chrono`: Chrono schedules the user manages directly. They are ordinary
 * conversation-owned schedules, so the model sees and may manage them too.
 */

import { chronoShortId } from "@exocortex/shared/chrono";
import type { ChronoCommand, ChronoRepeat, ChronoResultEvent, ChronoScheduleSummary } from "@exocortex/shared/protocol";
import {
  cancelChronoSchedule,
  createChronoSchedule,
  listChronoSchedules,
  type ChronoSchedule,
} from "./chrono-service";

function summarize(schedule: ChronoSchedule): ChronoScheduleSummary {
  return {
    id: schedule.id,
    title: schedule.title,
    nextAt: schedule.nextAt,
    kind: schedule.target.kind === "conversation" ? "message" : "command",
    payload: schedule.target.kind === "conversation" ? schedule.target.message : schedule.target.command,
    ...(schedule.recurrence ? { recurrence: schedule.recurrence } : {}),
    status: schedule.status ?? "scheduled",
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Wire repeats are untrusted; the scheduler validates values but expects these shapes. */
function wireRepeat(value: unknown): { repeat?: ChronoRepeat; error?: string } {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "Invalid Chrono repeat." };
  const repeat = value as Record<string, unknown>;
  if (typeof repeat.unit !== "string"
      || (repeat.interval !== undefined && typeof repeat.interval !== "number")
      || (repeat.weekdays !== undefined && (!Array.isArray(repeat.weekdays) || repeat.weekdays.some(day => typeof day !== "string")))) {
    return { error: "Invalid Chrono repeat." };
  }
  return { repeat: value as ChronoRepeat };
}

/** An exact id, `all`, or a unique prefix of a short id (with or without `chrono:`). */
function matchScheduleIds(query: string, schedules: ChronoSchedule[]): { ids?: string[]; error?: string } {
  const typed = query.trim();
  if (!typed) return { error: "Usage: /chrono cancel <id|all>" };
  if (typed === "all") {
    return schedules.length ? { ids: schedules.map(schedule => schedule.id) } : { error: "No Chrono schedules to cancel." };
  }
  if (schedules.some(schedule => schedule.id === typed)) return { ids: [typed] };
  const prefix = typed.replace(/^chrono:/, "").toLowerCase();
  const matches = schedules.filter(schedule => schedule.id.replace(/^chrono:/, "").toLowerCase().startsWith(prefix));
  if (matches.length === 1) return { ids: [matches[0].id] };
  if (matches.length === 0) return { error: `No Chrono schedule in this conversation matches ${typed}.` };
  return { error: `${typed} matches ${matches.length} schedules (${matches.map(schedule => chronoShortId(schedule.id)).join(", ")}); type more of the id.` };
}

export function runChronoCommand(cmd: ChronoCommand): { event?: ChronoResultEvent; error?: string } {
  const result = (extra: Partial<ChronoResultEvent> = {}): { event: ChronoResultEvent } => ({
    event: {
      type: "chrono_result",
      reqId: cmd.reqId,
      convId: cmd.convId,
      action: cmd.action,
      schedules: listChronoSchedules(cmd.convId).map(summarize),
      ...extra,
    },
  });

  if (cmd.action === "list") return result();

  if (cmd.action === "create") {
    const { repeat, error } = wireRepeat(cmd.repeat);
    if (error) return { error };
    const created = createChronoSchedule({
      ownerConversationId: cmd.convId,
      at: optionalString(cmd.at),
      repeat,
      timezone: optionalString(cmd.timezone),
      message: optionalString(cmd.message),
      command: optionalString(cmd.command),
    });
    if (!created.schedule) return { error: created.error ?? "Could not create Chrono schedule." };
    return result({ created: summarize(created.schedule) });
  }

  if (cmd.action === "cancel") {
    const matched = matchScheduleIds(optionalString(cmd.scheduleId) ?? "", listChronoSchedules(cmd.convId));
    if (!matched.ids) return { error: matched.error };
    const cancelled: Array<{ id: string; title: string }> = [];
    for (const id of matched.ids) {
      const outcome = cancelChronoSchedule(id, cmd.convId);
      if (outcome.cancelled) cancelled.push(outcome.cancelled);
    }
    return result({ cancelled });
  }

  return { error: "Invalid Chrono action. Use list, create, or cancel." };
}
