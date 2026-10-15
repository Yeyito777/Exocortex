import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DEFAULT_ROUTING_POLICY, type AccountRouteState } from "./routing";
import { applyDevRoutingOverrides, DEV_ROUTING_ENV } from "./routing-dev-overrides";

const NOW = 1_800_000_000_000;
const saved = process.env[DEV_ROUTING_ENV];
let dir: string;

const states = (): AccountRouteState[] => [
  { id: "main", available: true, limitedUntil: null, usage: { fiveHour: { utilization: 3, resetsAt: NOW + 1000 }, sevenDay: null }, activeTurns: 0 },
  { id: "max2", available: true, limitedUntil: null, usage: null, activeTurns: 1 },
];

function write(content: unknown): void {
  const path = join(dir, "routing.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  process.env[DEV_ROUTING_ENV] = path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "exo-dev-routing-"));
  delete process.env[DEV_ROUTING_ENV];
});

afterEach(() => {
  if (saved === undefined) delete process.env[DEV_ROUTING_ENV];
  else process.env[DEV_ROUTING_ENV] = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe("dev routing overrides", () => {
  test("off by default: states and the default policy pass through untouched", () => {
    const input = states();
    const result = applyDevRoutingOverrides(input, NOW);
    expect(result.states).toBe(input);
    expect(result.policy).toBe(DEFAULT_ROUTING_POLICY);
  });

  test("overrides the policy, usage, limits and availability per account", () => {
    write({
      policy: { cacheTtlMs: 20_000, weeklyFloor: 15 },
      accounts: {
        main: { usage: { sevenDay: { utilization: 95, resetsInMs: 3_600_000 } }, limitedForMs: 60_000 },
        max2: { available: false },
      },
    });
    const { states: [main, max2], policy } = applyDevRoutingOverrides(states(), NOW);
    expect(policy).toEqual({ ...DEFAULT_ROUTING_POLICY, cacheTtlMs: 20_000, weeklyFloor: 15 });
    expect(main.usage).toEqual({ fiveHour: null, sevenDay: { utilization: 95, resetsAt: NOW + 3_600_000 } });
    expect(main.limitedUntil).toBe(NOW + 60_000);
    expect(max2).toMatchObject({ available: false, usage: null, activeTurns: 1 });
  });

  test("a malformed file is ignored", () => {
    write("{ not json");
    const input = states();
    expect(applyDevRoutingOverrides(input, NOW)).toEqual({ states: input, policy: DEFAULT_ROUTING_POLICY });
  });
});
