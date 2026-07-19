const DURATION_PART_RE = /\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/iy;
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;

export function parseDurationMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const duration = value.trim();
  if (!duration) return null;

  let totalMs = 0;
  let offset = 0;
  while (offset < duration.length) {
    DURATION_PART_RE.lastIndex = offset;
    const match = DURATION_PART_RE.exec(duration);
    if (!match) return null;

    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const multiplier = unit === "ms" ? 1
      : unit === "s" ? 1_000
        : unit === "m" ? 60_000
          : unit === "h" ? 3_600_000
            : 86_400_000;
    totalMs += amount * multiplier;
    if (!Number.isFinite(totalMs)) return null;
    offset = DURATION_PART_RE.lastIndex;
  }

  const result = Math.round(totalMs);
  const maxDurationMs = MAX_DATE_TIMESTAMP_MS - Date.now();
  return Number.isSafeInteger(result) && result > 0 && result <= maxDurationMs ? result : null;
}
