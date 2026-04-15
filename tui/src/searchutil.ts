/**
 * Shared search helpers.
 *
 * Small, generic utilities for case-insensitive substring search used by both
 * chat-history search and sidebar conversation search.
 */

export type MatchDirection = "forward" | "backward";

export function findAllCaseInsensitiveMatchStarts(text: string, query: string): number[] {
  if (!query) return [];

  const matches: number[] = [];
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let pos = 0;

  while (pos <= lowerText.length - lowerQuery.length) {
    const idx = lowerText.indexOf(lowerQuery, pos);
    if (idx === -1) break;
    matches.push(idx);
    pos = idx + 1; // allow overlapping matches
  }

  return matches;
}

export function findCaseInsensitiveMatches(text: string, query: string): { from: number; to: number }[] {
  return findAllCaseInsensitiveMatchStarts(text, query).map((from) => ({ from, to: from + query.length }));
}

export function findNextSortedMatch(
  matches: number[],
  fromPos: number,
  direction: MatchDirection,
): number | null {
  if (matches.length === 0) return null;

  if (direction === "forward") {
    for (const matchPos of matches) {
      if (matchPos > fromPos) return matchPos;
    }
    return matches[0];
  }

  for (let i = matches.length - 1; i >= 0; i--) {
    if (matches[i] < fromPos) return matches[i];
  }
  return matches[matches.length - 1];
}
