import type { GenerationThroughput, ModelId, ProviderId } from "@exocortex/shared/messages";
import { REALTIME_TRANSCRIPT_KIND, type StoredMessage } from "./messages";
import { archiveWindow } from "./conversation-window";

/** Measures a single API request (TTFT + generation), not the agent message.
 * Retries invalidate the sample: backoff/reconnection is not generation time. */
export class ProviderGenerationTimer {
  private startedAt: number | null = null;
  private retried = false;

  constructor(private readonly now: () => number = () => performance.now()) {}

  reset(): void {
    this.startedAt = this.now();
    this.retried = false;
  }

  retry(): void {
    this.retried = true;
  }

  rate(tokens: number | undefined): number | null {
    if (this.startedAt === null || this.retried || tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) return null;
    const elapsed = this.now() - this.startedAt;
    if (!Number.isFinite(elapsed) || elapsed <= 0) return null;
    const rate = tokens / (elapsed / 1000);
    return Number.isFinite(rate) ? rate : null;
  }
}

export function generationThroughputForTurn(
  messages: StoredMessage[], provider: ProviderId, model: ModelId,
): GenerationThroughput | undefined {
  let previous: GenerationThroughput | undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant" || message.metadata?.kind === REALTIME_TRANSCRIPT_KIND) continue;
    previous = message.metadata?.generationThroughput;
    return previous?.provider === provider && previous.model === model ? previous : undefined;
  }
  previous = archiveWindow(messages)?.sparse?.workTimer?.generationThroughput;
  return previous?.provider === provider && previous.model === model ? previous : undefined;
}
