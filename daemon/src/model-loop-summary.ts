import type { LoopCheckpoint } from "./model-loop-profile";

export interface LoopRoundRecord {
  conversationId: string;
  turnId: string;
  round: number;
  pid?: number;
  outcome: string;
  startedAtMonotonicMs: number;
  checkpoints: LoopCheckpoint[];
}

function phase(record: LoopRoundRecord, name: string): number | undefined {
  return record.checkpoints.find(checkpoint => checkpoint.phase === name)?.atMs;
}

function duration(record: LoopRoundRecord, from: string, to: string): number | null {
  const start = phase(record, from);
  const end = phase(record, to);
  return start == null || end == null ? null : end - start;
}

export function summarizeLoopRounds(records: LoopRoundRecord[]) {
  const sorted = [...records].sort((a, b) => a.turnId.localeCompare(b.turnId) || a.round - b.round);
  return sorted.map((record, index) => {
    const next = sorted[index + 1];
    const toolsEnd = phase(record, "tools_end");
    const nextSent = next && phase(next, "request_sent");
    const sameProcess = next && (record.pid === next.pid || record.pid == null && next.pid == null);
    const contiguous = next && sameProcess && next.conversationId === record.conversationId
      && next.turnId === record.turnId && next.round === record.round + 1;
    const retried = record.checkpoints.some(checkpoint => checkpoint.phase === "retry");
    const handoff = record.outcome === "continue" && contiguous && toolsEnd != null && nextSent != null
      ? next.startedAtMonotonicMs + nextSent - (record.startedAtMonotonicMs + toolsEnd)
      : null;
    return {
      turnId: record.turnId, round: record.round, outcome: record.outcome, retried,
      providerMs: duration(record, "provider_start", "provider_end"),
      // Do not report a blended "TTFT" across retries as a clean request sample.
      requestSetupMs: retried ? null : duration(record, "provider_start", "request_sent"),
      sentToFirstResponseMs: retried ? null : duration(record, "request_sent", "first_response"),
      sentToFirstOutputMs: retried ? null : duration(record, "request_sent", "first_output"),
      sentToFirstTextMs: retried ? null : duration(record, "request_sent", "first_text"),
      sentToFirstThinkingMs: retried ? null : duration(record, "request_sent", "first_thinking"),
      presentationMs: duration(record, "presentation_start", "presentation_end"),
      toolsMs: duration(record, "tools_start", "tools_end"),
      recoveryMs: duration(record, "tools_end", "recovery_committed"),
      compactionMs: duration(record, "compaction_start", "compaction_end"),
      toolToNextRequestMs: handoff != null && handoff >= 0 ? handoff : null,
      requestBytes: record.checkpoints.filter(checkpoint => checkpoint.phase === "request_sent").map(checkpoint => checkpoint.bytes),
    };
  });
}
