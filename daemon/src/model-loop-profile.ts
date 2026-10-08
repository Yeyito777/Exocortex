import { recordModelLoopDiagnostics } from "./diagnostics";

export interface LoopCheckpoint {
  phase: string;
  atMs: number;
  transport?: "websocket" | "http";
  bytes?: number;
}

/** Opt-in, content-free monotonic trace. No clocks or allocations when disabled. */
export class ModelLoopProfile {
  private readonly startedAt: number;
  private readonly startedAtMonotonicMs: number;
  private readonly checkpoints: LoopCheckpoint[] = [];
  private readonly seen = new Set<string>();

  constructor(
    private readonly identity: { conversationId?: string; turnId: string; round: number; provider: string; model: string },
    private readonly now: () => number = () => performance.now(),
    private readonly sink = recordModelLoopDiagnostics,
  ) {
    this.startedAt = Date.now();
    this.startedAtMonotonicMs = now();
  }

  mark(phase: string, details: Pick<LoopCheckpoint, "transport" | "bytes"> = {}): void {
    this.checkpoints.push({ phase, atMs: this.now() - this.startedAtMonotonicMs, ...details });
  }

  once(phase: string): void {
    if (this.seen.has(phase)) return;
    this.seen.add(phase);
    this.mark(phase);
  }

  finish(outcome: string): void {
    this.mark("round_end");
    this.sink({
      ...this.identity,
      startedAt: this.startedAt,
      startedAtMonotonicMs: this.startedAtMonotonicMs,
      outcome,
      checkpoints: this.checkpoints,
    });
  }
}
