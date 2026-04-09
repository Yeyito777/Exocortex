/**
 * Tests for the cron scheduler.
 *
 * Tests the cron expression parser, schedule matching, and script
 * header parsing by importing the actual functions from scheduler.ts.
 */

import { describe, test, expect } from "bun:test";
import {
  parseCronField,
  parseSchedule,
  fieldMatches,
  dayMatches,
  scheduleMatches,
  parseHeaders,
} from "./scheduler";

// ── parseCronField ──────────────────────────────────────────────────

describe("parseCronField", () => {
  test("wildcard", () => {
    const f = parseCronField("*", 0, 59);
    expect(f).toEqual({ type: "any", values: [] });
  });

  test("single value", () => {
    const f = parseCronField("5", 0, 59);
    expect(f).toEqual({ type: "values", values: [5] });
  });

  test("comma-separated values", () => {
    const f = parseCronField("0,15,30,45", 0, 59);
    expect(f).toEqual({ type: "values", values: [0, 15, 30, 45] });
  });

  test("range", () => {
    const f = parseCronField("1-5", 0, 6);
    expect(f).toEqual({ type: "values", values: [1, 2, 3, 4, 5] });
  });

  test("step with wildcard", () => {
    const f = parseCronField("*/15", 0, 59);
    expect(f).toEqual({ type: "values", values: [0, 15, 30, 45] });
  });

  test("step with range", () => {
    const f = parseCronField("1-30/10", 0, 59);
    expect(f).toEqual({ type: "values", values: [1, 11, 21] });
  });

  test("combined range and values", () => {
    const f = parseCronField("1-3,7,10-12", 1, 31);
    expect(f).toEqual({ type: "values", values: [1, 2, 3, 7, 10, 11, 12] });
  });

  // ── Validation ──────────────────────────────────────────────────

  test("rejects value below min", () => {
    expect(parseCronField("0", 1, 31)).toBeNull();
  });

  test("rejects value above max", () => {
    expect(parseCronField("60", 0, 59)).toBeNull();
  });

  test("rejects range with out-of-bounds start", () => {
    expect(parseCronField("0-5", 1, 31)).toBeNull();
  });

  test("rejects range with out-of-bounds end", () => {
    expect(parseCronField("55-65", 0, 59)).toBeNull();
  });

  test("rejects non-numeric value", () => {
    expect(parseCronField("abc", 0, 59)).toBeNull();
  });

  test("rejects non-numeric in range", () => {
    expect(parseCronField("a-5", 0, 59)).toBeNull();
  });

  test("rejects non-numeric step", () => {
    expect(parseCronField("*/abc", 0, 59)).toBeNull();
  });

  test("rejects zero step", () => {
    expect(parseCronField("*/0", 0, 59)).toBeNull();
  });

  test("rejects step range with out-of-bounds", () => {
    expect(parseCronField("0-70/5", 0, 59)).toBeNull();
  });

  test("boundary: min value accepted", () => {
    const f = parseCronField("0", 0, 59);
    expect(f).toEqual({ type: "values", values: [0] });
  });

  test("boundary: max value accepted", () => {
    const f = parseCronField("59", 0, 59);
    expect(f).toEqual({ type: "values", values: [59] });
  });
});

// ── parseSchedule ───────────────────────────────────────────────────

describe("parseSchedule", () => {
  test("parses standard 5-field expression", () => {
    const s = parseSchedule("0 9 * * 1-5");
    expect(s).not.toBeNull();
    expect(s!.minute).toEqual({ type: "values", values: [0] });
    expect(s!.hour).toEqual({ type: "values", values: [9] });
    expect(s!.dayOfMonth.type).toBe("any");
    expect(s!.month.type).toBe("any");
    expect(s!.dayOfWeek).toEqual({ type: "values", values: [1, 2, 3, 4, 5] });
  });

  test("rejects too few fields", () => {
    expect(parseSchedule("0 9 *")).toBeNull();
  });

  test("rejects too many fields", () => {
    expect(parseSchedule("0 9 * * 1 extra")).toBeNull();
  });

  test("every 30 minutes", () => {
    const s = parseSchedule("*/30 * * * *");
    expect(s).not.toBeNull();
    expect(s!.minute).toEqual({ type: "values", values: [0, 30] });
  });

  test("rejects expression with out-of-range field", () => {
    // minute 99 is invalid
    expect(parseSchedule("99 9 * * *")).toBeNull();
  });

  test("rejects expression with non-numeric field", () => {
    expect(parseSchedule("abc 9 * * *")).toBeNull();
  });

  test("rejects expression with invalid month", () => {
    // month 13 is invalid (range 1-12)
    expect(parseSchedule("0 9 * 13 *")).toBeNull();
  });

  test("rejects expression with invalid day-of-week", () => {
    // day-of-week 7 is invalid (range 0-6)
    expect(parseSchedule("0 9 * * 7")).toBeNull();
  });
});

// ── dayMatches ──────────────────────────────────────────────────────

describe("dayMatches", () => {
  test("wildcard DOM defers to DOW", () => {
    const dom = parseCronField("*", 1, 31)!;
    const dow = parseCronField("1-5", 0, 6)!;
    expect(dayMatches(dom, dow, new Date(2026, 2, 16, 9, 0))).toBe(true); // Monday
    expect(dayMatches(dom, dow, new Date(2026, 2, 15, 9, 0))).toBe(false); // Sunday
  });

  test("wildcard DOW defers to DOM", () => {
    const dom = parseCronField("15", 1, 31)!;
    const dow = parseCronField("*", 0, 6)!;
    expect(dayMatches(dom, dow, new Date(2026, 2, 15, 9, 0))).toBe(true);
    expect(dayMatches(dom, dow, new Date(2026, 2, 16, 9, 0))).toBe(false);
  });

  test("restricted DOM and DOW use cron OR semantics", () => {
    const dom = parseCronField("15", 1, 31)!;
    const dow = parseCronField("1", 0, 6)!;
    expect(dayMatches(dom, dow, new Date(2026, 2, 15, 9, 0))).toBe(true); // 15th, Sunday
    expect(dayMatches(dom, dow, new Date(2026, 2, 16, 9, 0))).toBe(true); // Monday, 16th
    expect(dayMatches(dom, dow, new Date(2026, 2, 17, 9, 0))).toBe(false); // Tuesday, 17th
  });
});

// ── scheduleMatches ─────────────────────────────────────────────────

describe("scheduleMatches", () => {
  test("every minute matches any time", () => {
    const s = parseSchedule("* * * * *")!;
    expect(scheduleMatches(s, new Date(2026, 2, 15, 10, 30))).toBe(true);
    expect(scheduleMatches(s, new Date(2026, 0, 1, 0, 0))).toBe(true);
  });

  test("9am daily matches at 9:00", () => {
    const s = parseSchedule("0 9 * * *")!;
    expect(scheduleMatches(s, new Date(2026, 2, 15, 9, 0))).toBe(true);
    expect(scheduleMatches(s, new Date(2026, 2, 15, 9, 1))).toBe(false);
    expect(scheduleMatches(s, new Date(2026, 2, 15, 10, 0))).toBe(false);
  });

  test("weekdays only (1-5)", () => {
    const s = parseSchedule("0 9 * * 1-5")!;
    // March 15, 2026 is a Sunday (day 0)
    expect(scheduleMatches(s, new Date(2026, 2, 15, 9, 0))).toBe(false);
    // March 16, 2026 is a Monday (day 1)
    expect(scheduleMatches(s, new Date(2026, 2, 16, 9, 0))).toBe(true);
  });

  test("Friday 6pm", () => {
    const s = parseSchedule("0 18 * * 5")!;
    // March 20, 2026 is a Friday
    expect(scheduleMatches(s, new Date(2026, 2, 20, 18, 0))).toBe(true);
    expect(scheduleMatches(s, new Date(2026, 2, 20, 17, 0))).toBe(false);
    // March 19, 2026 is a Thursday
    expect(scheduleMatches(s, new Date(2026, 2, 19, 18, 0))).toBe(false);
  });

  test("every 30 minutes", () => {
    const s = parseSchedule("*/30 * * * *")!;
    expect(scheduleMatches(s, new Date(2026, 2, 15, 10, 0))).toBe(true);
    expect(scheduleMatches(s, new Date(2026, 2, 15, 10, 30))).toBe(true);
    expect(scheduleMatches(s, new Date(2026, 2, 15, 10, 15))).toBe(false);
  });

  test("restricted DOM and DOW use cron OR semantics", () => {
    const s = parseSchedule("0 9 15 * 1")!;
    expect(scheduleMatches(s, new Date(2026, 2, 15, 9, 0))).toBe(true); // 15th
    expect(scheduleMatches(s, new Date(2026, 2, 16, 9, 0))).toBe(true); // Monday
    expect(scheduleMatches(s, new Date(2026, 2, 17, 9, 0))).toBe(false);
  });

  test("specific month and day", () => {
    const s = parseSchedule("0 0 1 1 *")!; // midnight, Jan 1st
    expect(scheduleMatches(s, new Date(2026, 0, 1, 0, 0))).toBe(true);
    expect(scheduleMatches(s, new Date(2026, 1, 1, 0, 0))).toBe(false);
  });
});

// ── parseHeaders ────────────────────────────────────────────────────

describe("parseHeaders", () => {
  test("parses all headers", () => {
    const script = `#!/bin/bash
# schedule: 0 9 * * *
# description: Morning email check
# timeout: 120

echo "hello"`;

    const h = parseHeaders(script);
    expect(h.schedule).toBe("0 9 * * *");
    expect(h.description).toBe("Morning email check");
    expect(h.timeout).toBe(120);
  });

  test("defaults when headers missing", () => {
    const script = `#!/bin/bash
# schedule: */30 * * * *

echo "hello"`;

    const h = parseHeaders(script);
    expect(h.schedule).toBe("*/30 * * * *");
    expect(h.description).toBe("");
    expect(h.timeout).toBe(300);
  });

  test("no schedule returns null", () => {
    const script = `#!/bin/bash
# Just a regular script
echo "hello"`;

    const h = parseHeaders(script);
    expect(h.schedule).toBeNull();
  });

  test("case insensitive header names", () => {
    const script = `#!/bin/bash
# Schedule: 0 9 * * *
# DESCRIPTION: Test job
# Timeout: 60`;

    const h = parseHeaders(script);
    expect(h.schedule).toBe("0 9 * * *");
    expect(h.description).toBe("Test job");
    expect(h.timeout).toBe(60);
  });

  test("ignores non-comment lines", () => {
    const script = `#!/bin/bash
echo "schedule: not this"
# schedule: 0 9 * * *`;

    const h = parseHeaders(script);
    expect(h.schedule).toBe("0 9 * * *");
  });
});
