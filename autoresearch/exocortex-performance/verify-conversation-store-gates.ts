#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const resultDir = join(import.meta.dir, "results");
const fullPath = join(resultDir, "conversation-store-full.json");
const scalePath = join(resultDir, "conversation-store-50000-startup.json");
if (!existsSync(fullPath)) throw new Error(`Missing full benchmark: ${fullPath}`);
if (!existsSync(scalePath)) throw new Error(`Missing 50k benchmark: ${scalePath}`);
const full = JSON.parse(readFileSync(fullPath, "utf8"));
const scale = JSON.parse(readFileSync(scalePath, "utf8"));
const checks: Array<{ name: string; ok: boolean; actual: number; required: string }> = [];

function check(name: string, ok: boolean, actual: number, required: string): void {
  checks.push({ name, ok, actual, required });
}
function speedup(json: any, sqlite: any): number {
  return json.medianMs / sqlite.medianMs;
}

const lowJson = full.lowScale.jsonStartupAndList;
const lowSqlite = full.lowScale.sqliteStartupAndList;
const medianAllowance = Math.max(lowJson.medianMs * 0.15, 2);
const p95Allowance = Math.max(lowJson.p95Ms * 0.25, 5);
check("low-scale median regression ms", lowSqlite.medianMs - lowJson.medianMs <= medianAllowance, lowSqlite.medianMs - lowJson.medianMs, `<= ${medianAllowance}`);
check("low-scale p95 regression ms", lowSqlite.p95Ms - lowJson.p95Ms <= p95Allowance, lowSqlite.p95Ms - lowJson.p95Ms, `<= ${p95Allowance}`);
check("interactive metadata write p95 ms", full.largeScale.sqliteMetadataWrite.p95Ms < 50, full.largeScale.sqliteMetadataWrite.p95Ms, "< 50");
check("10k startup/list speedup", speedup(full.largeScale.jsonStartupAndList, full.largeScale.sqliteStartupAndList) >= 2, speedup(full.largeScale.jsonStartupAndList, full.largeScale.sqliteStartupAndList), ">= 2x");
for (const size of ["10", "50", "96"]) {
  const value = full.largeAppend[size];
  check(`${size} MiB append speedup`, speedup(value.json, value.sqlite) >= 5, speedup(value.json, value.sqlite), ">= 5x");
}
const sqliteAppendMedians = Object.values(full.largeAppend).map((value: any) => value.sqlite.medianMs) as number[];
const appendSpread = Math.max(...sqliteAppendMedians) / Math.min(...sqliteAppendMedians);
check("SQLite append historical-size spread", appendSpread <= 2, appendSpread, "<= 2x max/min");
check("10k SQLite positive RSS delta MiB", full.largeScale.sqliteStartupAndList.maxRssDelta <= 128 * 1024 * 1024, full.largeScale.sqliteStartupAndList.maxRssDelta / 1024 / 1024, "<= 128 MiB");
check("10k SQLite/JSON storage ratio", full.storageBytes.sqliteSynthetic / full.storageBytes.jsonSynthetic <= 1.5, full.storageBytes.sqliteSynthetic / full.storageBytes.jsonSynthetic, "<= 1.5x");
check("50k dataset count", scale.methodology.syntheticConversationCount === 50_000, scale.methodology.syntheticConversationCount, "= 50000");
check("50k startup/list speedup", speedup(scale.largeScale.jsonStartupAndList, scale.largeScale.sqliteStartupAndList) >= 2, speedup(scale.largeScale.jsonStartupAndList, scale.largeScale.sqliteStartupAndList), ">= 2x");
check("50k SQLite positive RSS delta MiB", scale.largeScale.sqliteStartupAndList.maxRssDelta <= 256 * 1024 * 1024, scale.largeScale.sqliteStartupAndList.maxRssDelta / 1024 / 1024, "<= 256 MiB");

const report = {
  version: 1,
  verifiedAt: new Date().toISOString(),
  fullResult: "results/conversation-store-full.json",
  scaleResult: "results/conversation-store-50000-startup.json",
  passed: checks.filter((entry) => entry.ok).length,
  failed: checks.filter((entry) => !entry.ok).length,
  checks,
};
const output = join(resultDir, "conversation-store-gates.json");
writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, passed: report.passed, failed: report.failed, checks }, null, 2));
if (report.failed > 0) process.exit(1);
