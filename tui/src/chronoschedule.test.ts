import { describe, expect, test } from "bun:test";
import type { CalendarRecurrence } from "@exocortex/shared/chrono";
import { CHRONO_USAGE, formatChronoRecurrence, formatChronoResult, parseChronoArgs } from "./chronoschedule";
import type { ChronoScheduleSummary } from "./protocol";

// Friday, October 9, 2026, 15:30 in whatever timezone the tests run in.
const NOW = new Date(2026, 9, 9, 15, 30).getTime();
const local = (month: number, day: number, hour: number, minute = 0) => new Date(2026, month - 1, day, hour, minute).getTime();

function create(text: string) {
  const parsed = parseChronoArgs(text, NOW);
  if (!("action" in parsed) || parsed.action !== "create") throw new Error(`expected a schedule from ${text}: ${JSON.stringify(parsed)}`);
  return parsed;
}

function error(text: string): string {
  const parsed = parseChronoArgs(text, NOW);
  if (!("error" in parsed)) throw new Error(`expected an error from ${text}: ${JSON.stringify(parsed)}`);
  return parsed.error;
}

describe("/chrono syntax", () => {
  test("lists, cancels, and explains", () => {
    expect(parseChronoArgs("", NOW)).toEqual({ action: "list" });
    expect(parseChronoArgs(" list ", NOW)).toEqual({ action: "list" });
    expect(parseChronoArgs("cancel 3F2a1b9c", NOW)).toEqual({ action: "cancel", scheduleId: "3F2a1b9c" });
    expect(error("cancel")).toBe("Usage: /chrono cancel <id|all>");
    expect(error("hello there")).toBe(CHRONO_USAGE);
  });

  test("schedules once after a delay, keeping the message verbatim", () => {
    expect(create("30m check the build")).toEqual({ action: "create", at: NOW + 30 * 60_000, message: "check the build" });
    expect(create("in 2h 30m  first line\n  second line ")).toEqual({
      action: "create", at: NOW + 150 * 60_000, message: "first line\n  second line",
    });
    expect(create("in 1d1h x").at).toBe(NOW + 25 * 3_600_000);
    expect(error("in soon x")).toContain("Add a delay after in");
  });

  test("schedules once at the next matching local time", () => {
    expect(create("at 9am standup")).toEqual({ action: "create", at: local(10, 10, 9), message: "standup" });
    expect(create("17:00 x").at).toBe(local(10, 9, 17));
    expect(create("9 pm x").at).toBe(local(10, 9, 21));
    expect(create("at 12am x").at).toBe(local(10, 10, 0));
    expect(create("noon x").at).toBe(local(10, 10, 12));
    expect(create("tomorrow 14:30 x").at).toBe(local(10, 10, 14, 30));
    expect(create("fri 5pm x").at).toBe(local(10, 9, 17));
    expect(create("friday 3pm x").at).toBe(local(10, 16, 15));
    expect(create("at mon 8:15 x").at).toBe(local(10, 12, 8, 15));
    expect(create("2026-12-24 18:00 x").at).toBe(local(12, 24, 18));
    expect(create("at 2026-10-10T08:00 x").at).toBe(local(10, 10, 8));
    expect(create("at 2026-10-10T08:00:00Z x").at).toBe(Date.parse("2026-10-10T08:00:00Z"));
  });

  test("does not read prose or impossible times as a time", () => {
    expect(error("at 9 x")).toBe(CHRONO_USAGE);
    expect(error("at 25:00 x")).toBe(CHRONO_USAGE);
    expect(error("at 13pm x")).toBe(CHRONO_USAGE);
    expect(error("today 9am x")).toContain("already passed");
    expect(error("2026-01-01 9am x")).toContain("already passed");
    expect(error("at 2026-02-30 9am x")).toContain("Not a date");
    expect(error("tomorrow call mom")).toContain("Add a time");
  });

  test("repeats on fixed periods", () => {
    expect(create("every 2h check")).toEqual({ action: "create", at: NOW + 2 * 3_600_000, repeat: { unit: "hour", interval: 2 }, message: "check" });
    expect(create("every 1h x").repeat).toEqual({ unit: "hour" });
    expect(create("hourly x").repeat).toEqual({ unit: "hour" });
    expect(create("every 90m x").repeat).toEqual({ unit: "minute", interval: 90 });
    expect(create("every 15 minutes x").repeat).toEqual({ unit: "minute", interval: 15 });
    expect(create("every 2h at 9am x")).toEqual(expect.objectContaining({ at: local(10, 10, 9), repeat: { unit: "hour", interval: 2 } }));
    expect(error("every 30s x")).toContain("whole minutes");
  });

  test("repeats on calendar days, weeks, and months", () => {
    expect(create("every day at 9am summarize email")).toEqual({
      action: "create", at: local(10, 10, 9), repeat: { unit: "day" }, message: "summarize email",
    });
    expect(create("daily 9am x")).toEqual(expect.objectContaining({ at: local(10, 10, 9), repeat: { unit: "day" } }));
    expect(create("every 2 days at 9am x").repeat).toEqual({ unit: "day", interval: 2 });
    expect(create("every 2d x")).toEqual(expect.objectContaining({ at: local(10, 11, 15, 30), repeat: { unit: "day", interval: 2 } }));
    expect(create("every week at fri 17:00 x")).toEqual(expect.objectContaining({ at: local(10, 9, 17), repeat: { unit: "week" } }));
    expect(create("every month at 2026-11-01 9am pay rent")).toEqual({
      action: "create", at: local(11, 1, 9), repeat: { unit: "month" }, message: "pay rent",
    });
  });

  test("repeats on chosen weekdays from their next occurrence", () => {
    expect(create("every weekday at 8:30 x")).toEqual(expect.objectContaining({
      at: local(10, 12, 8, 30), repeat: { unit: "week", weekdays: ["mon", "tue", "wed", "thu", "fri"] },
    }));
    expect(create("every thu, mon at 18:00 x")).toEqual(expect.objectContaining({
      at: local(10, 12, 18), repeat: { unit: "week", weekdays: ["mon", "thu"] },
    }));
    expect(create("every weekend 10am x").repeat).toEqual({ unit: "week", weekdays: ["sun", "sat"] });
    expect(create("every fri x").at).toBe(local(10, 16, 15, 30));
    expect(error("every weekday at tomorrow 9am x")).toContain("Give only a time");
  });

  test("needs a period and a payload; ! runs a shell command", () => {
    expect(create("every 2h !echo hi")).toEqual(expect.objectContaining({ command: "echo hi" }));
    expect(create("every 2h !echo hi").message).toBeUndefined();
    expect(error("30m !")).toContain("shell command");
    expect(error("every day at 9am")).toContain("Add a message");
    expect(error("every at 9am x")).toContain("Say how often");
    expect(error("every 9am x")).toContain("Say how often");
    expect(error("every day at x")).toContain("Add a time after at");
  });
});

describe("/chrono display", () => {
  const calendar = (overrides: Partial<CalendarRecurrence>): CalendarRecurrence => ({
    kind: "calendar", unit: "day", interval: 1, timezone: "America/Chicago",
    hour: 9, minute: 0, second: 0, anchorDate: "2026-10-10", ...overrides,
  });

  test("describes recurrences in the user's terms", () => {
    expect(formatChronoRecurrence({ kind: "interval", everyMs: 5_400_000, anchorAt: 0 })).toBe("every 1h30m");
    expect(formatChronoRecurrence(calendar({}), "America/Chicago")).toBe("every day at 09:00");
    expect(formatChronoRecurrence(calendar({ interval: 2 }), "Europe/Paris")).toBe("every 2 days at 09:00 America/Chicago");
    expect(formatChronoRecurrence(calendar({ unit: "week", weekdays: [5, 1, 2, 3, 4], minute: 30 }), "America/Chicago"))
      .toBe("every weekday at 09:30");
    expect(formatChronoRecurrence(calendar({ unit: "week", interval: 2, weekdays: [1, 4] }), "America/Chicago"))
      .toBe("every 2 weeks on Mon, Thu at 09:00");
    expect(formatChronoRecurrence(calendar({ unit: "month", dayOfMonth: 22 }), "America/Chicago")).toBe("every month on the 22nd at 09:00");
    expect(formatChronoRecurrence({ kind: "cron", expression: "0 9 * * *" })).toBe("cron 0 9 * * *");
  });

  test("reports created, cancelled, and listed schedules", () => {
    const schedule: ChronoScheduleSummary = {
      id: "chrono:3f2a1b9c-0000-4000-8000-000000000000",
      title: "check the build",
      nextAt: NOW + 30 * 60_000,
      kind: "message",
      payload: "check the build",
      status: "scheduled",
    };
    const result = { type: "chrono_result" as const, convId: "c", schedules: [schedule] };
    expect(formatChronoResult({ ...result, action: "create", created: schedule }, NOW)).toBe("Scheduled 3f2a1b9c  16:00 (in 30m) · once · check the build");
    expect(formatChronoResult({ ...result, action: "cancel", schedules: [], cancelled: [{ id: schedule.id, title: schedule.title }] }, NOW))
      .toBe("Cancelled 3f2a1b9c · check the build");
    expect(formatChronoResult({ ...result, action: "list", schedules: [{ ...schedule, kind: "command", payload: "make  test", status: "running" }] }, NOW))
      .toBe("Chrono schedules (1):\n  3f2a1b9c  16:00 (in 30m) · once · running · !make test");
    expect(formatChronoResult({ ...result, action: "list", schedules: [] }, NOW)).toContain("No Chrono schedules");
  });
});
