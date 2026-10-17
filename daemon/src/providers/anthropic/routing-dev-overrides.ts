/**
 * Dev/test-only overrides for Claude account routing, for live tests on a
 * test daemon whose accounts' real usage cannot be moved.
 *
 * Off unless `EXOCORTEX_DEV_CLAUDE_ROUTING` names a JSON file. The file is
 * read again at every routing decision, so a test can change it while the
 * daemon runs. It changes only what routing sees (account-pool.ts): the
 * policy, and each account's usage, limit and availability. The usage bars,
 * `/account claude` and the accounts themselves are untouched.
 *
 * ```json
 * {
 *   "policy": { "cacheTtlMs": 20000, "weeklyFloor": 15, "coldMoveRatio": 1.5 },
 *   "accounts": {
 *     "main": { "usage": { "sevenDay": { "utilization": 50, "resetsInMs": 3600000 } } },
 *     "max2": { "limitedForMs": 600000 }
 *   }
 * }
 * ```
 *
 * `policy` takes any `RoutingPolicy` field (floors, `fiveHourComfort`,
 * `scoreTie`, `coldMoveRatio`, `cacheTtlMs`); the rest keep their defaults.
 * Account fields: `usage` replaces the account's usage snapshot (each window
 * `{ utilization, resetsAt }` or `{ utilization, resetsInMs }`, `null` for no
 * data); `limitedForMs` / `limitedUntil` mark it rejected at a usage limit;
 * `available: false` treats it as signed out or blocked. See
 * docs/claude-accounts.md ("Testing routing live").
 */

import { readFileSync } from "fs";
import type { UsageData, UsageWindow } from "../../messages";
import { log } from "../../log";
import { DEFAULT_ROUTING_POLICY, type AccountRouteState, type RoutingPolicy } from "./routing";

export const DEV_ROUTING_ENV = "EXOCORTEX_DEV_CLAUDE_ROUTING";

interface WindowOverride {
  utilization: number;
  resetsAt?: number | null;
  resetsInMs?: number;
}

interface AccountOverride {
  usage?: { fiveHour?: WindowOverride | null; sevenDay?: WindowOverride | null } | null;
  limitedUntil?: number | null;
  limitedForMs?: number;
  available?: boolean;
}

interface DevRoutingFile {
  policy?: Partial<RoutingPolicy>;
  accounts?: Record<string, AccountOverride>;
}

let lastError: string | null = null;
let announced = false;

function readOverrides(): DevRoutingFile | null {
  const path = process.env[DEV_ROUTING_ENV]?.trim();
  if (!path) return null;
  if (!announced) log("warn", `anthropic: dev routing overrides active from ${DEV_ROUTING_ENV}=${path}`);
  announced = true;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as DevRoutingFile;
    lastError = null;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== lastError) log("warn", `anthropic: ignoring ${DEV_ROUTING_ENV} (${path}): ${message}`);
    lastError = message;
    return null;
  }
}

function toWindow(window: WindowOverride | null | undefined, now: number): UsageWindow | null {
  if (!window || typeof window.utilization !== "number") return null;
  const resetsAt = typeof window.resetsInMs === "number" ? now + window.resetsInMs : window.resetsAt ?? null;
  return { utilization: window.utilization, resetsAt };
}

function toUsage(usage: AccountOverride["usage"], now: number): UsageData | null {
  if (!usage) return null;
  return { fiveHour: toWindow(usage.fiveHour, now), sevenDay: toWindow(usage.sevenDay, now) };
}

/** Routing's view of the accounts and its policy, with the dev overrides applied when the env var is set. */
export function applyDevRoutingOverrides(
  states: AccountRouteState[],
  now: number,
): { states: AccountRouteState[]; policy: RoutingPolicy } {
  const file = readOverrides();
  if (!file) return { states, policy: DEFAULT_ROUTING_POLICY };
  const policy = { ...DEFAULT_ROUTING_POLICY, ...file.policy };
  const overrides = file.accounts ?? {};
  return {
    policy,
    states: states.map((state) => {
      const override = overrides[state.id];
      if (!override) return state;
      const next = { ...state };
      if ("usage" in override) next.usage = toUsage(override.usage, now);
      if (typeof override.limitedForMs === "number") next.limitedUntil = now + override.limitedForMs;
      else if ("limitedUntil" in override) next.limitedUntil = override.limitedUntil ?? null;
      if (typeof override.available === "boolean") next.available = override.available;
      return next;
    }),
  };
}
