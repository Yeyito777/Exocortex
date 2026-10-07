import type { GenerationThroughput, ModelId, ProviderId } from "./messages";

export const GENERATION_RATE_CUTOFF = 10;
export const GENERATION_RATE_ALPHA = 2 / (GENERATION_RATE_CUTOFF + 1);

function samples(throughput: GenerationThroughput | undefined): number[] {
  const rates = throughput?.rates;
  return (Array.isArray(rates) ? rates : [])
    .filter(rate => Number.isFinite(rate) && rate > 0)
    .slice(-GENERATION_RATE_CUTOFF);
}

export function appendGenerationRate(
  previous: GenerationThroughput | undefined,
  provider: ProviderId,
  model: ModelId,
  rate: number,
): GenerationThroughput | undefined {
  if (!Number.isFinite(rate) || rate <= 0) return previous;
  const rates = previous?.provider === provider && previous.model === model ? samples(previous) : [];
  return { provider, model, rates: [...rates, rate].slice(-GENERATION_RATE_CUTOFF) };
}

/** Normalized exponential weights over the last ten API rounds, newest first.
 * Unlike an unbounded recursive EMA, samples older than the cutoff have no weight. */
export function generationTokensPerSecond(throughput: GenerationThroughput | undefined): number | null {
  const rates = samples(throughput);
  if (!rates.length) return null;
  let total = 0;
  let weights = 0;
  let weight = 1;
  for (let index = rates.length - 1; index >= 0; index--) {
    total += rates[index] * weight;
    weights += weight;
    weight *= 1 - GENERATION_RATE_ALPHA;
  }
  const rate = total / weights;
  return Number.isFinite(rate) ? rate : null;
}
