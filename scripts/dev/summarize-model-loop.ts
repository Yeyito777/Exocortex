#!/usr/bin/env bun
/** Offline only: summarize this instance's opt-in traces, with no model calls. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { diagnosticsDir } from "../../shared/src/paths";
import { summarizeLoopRounds, type LoopRoundRecord } from "../../daemon/src/model-loop-summary";

const convId = process.argv[2];
if (!convId) throw new Error("Usage: bun scripts/dev/summarize-model-loop.ts <conversation-id>");
const dir = join(diagnosticsDir(), "model-loop");
const records: LoopRoundRecord[] = [];
for (const file of readdirSync(dir).filter(file => file.endsWith(".jsonl"))) {
  const lines = readFileSync(join(dir, file), "utf8").trim().split("\n");
  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { continue; } // concurrent append may leave an incomplete last line
    if (record.type === "model_loop_round" && record.conversationId === convId) records.push(record);
  }
}
console.log(JSON.stringify({ conversationId: convId, rounds: summarizeLoopRounds(records) }, null, 2));
