/**
 * Replace one orchestrator-owned turn prefix without deleting messages that
 * another subsystem appended while the provider stream was running.
 *
 * External messages retain the boundary at which they appeared: a message
 * observed after N old owned messages remains after N replacement messages.
 */
export function mergeTurnTranscript<T extends object>(
  currentTail: readonly T[],
  ownedMessages: WeakSet<T>,
  replacement: readonly T[],
): T[] {
  const externalAtBoundary = new Map<number, T[]>();
  let ownedBefore = 0;
  for (const message of currentTail) {
    if (ownedMessages.has(message)) {
      ownedBefore += 1;
      continue;
    }
    const boundary = Math.min(ownedBefore, replacement.length);
    const bucket = externalAtBoundary.get(boundary) ?? [];
    bucket.push(message);
    externalAtBoundary.set(boundary, bucket);
  }

  const merged: T[] = [];
  for (let boundary = 0; boundary <= replacement.length; boundary++) {
    merged.push(...(externalAtBoundary.get(boundary) ?? []));
    if (boundary < replacement.length) {
      const message = replacement[boundary]!;
      ownedMessages.add(message);
      merged.push(message);
    }
  }
  return merged;
}
