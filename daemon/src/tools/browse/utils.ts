import type { CandidateLink, RelevantLink } from "./types";
import { MAX_RELEVANT_LINKS } from "./types";

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function stripMarkdown(text: string): string {
  return normalizeWhitespace(text.replace(/[*_`~]+/g, ""));
}

export function tokenizeText(text?: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length < 3) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    keywords.push(token);
    if (keywords.length >= 24) break;
  }
  return keywords;
}

export function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export function countKeywordMatches(text: string, keywords: string[]): number {
  let matches = 0;
  for (const keyword of keywords) {
    if (text.includes(keyword)) matches += 1;
  }
  return matches;
}

export function dedupeOrderedLinks(links: CandidateLink[]): RelevantLink[] {
  const seen = new Set<string>();
  const out: RelevantLink[] = [];
  for (const link of links) {
    if (seen.has(link.url)) continue;
    seen.add(link.url);
    out.push({ text: link.text, url: link.url });
    if (out.length >= MAX_RELEVANT_LINKS) break;
  }
  return out;
}
