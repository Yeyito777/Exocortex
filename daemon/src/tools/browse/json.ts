import type { RelevantLink, ScoredRelevantLink } from "./types";
import { MAX_RELEVANT_LINKS, MIN_LINK_SCORE } from "./types";
import { countKeywordMatches, tokenizeText } from "./utils";

const JSON_URL_KEY_PATTERNS = [
  /project_urls?/i,
  /documentation/i,
  /docs?/i,
  /homepage/i,
  /home_page/i,
  /repository/i,
  /source/i,
  /source_code/i,
  /tracker/i,
  /issue/i,
  /bug/i,
  /changelog/i,
  /download/i,
  /package_url/i,
  /project_url/i,
  /release_url/i,
  /community/i,
  /discussion/i,
];

function prettyJsonLabel(path: string[], url: string): string {
  const label = path[path.length - 1] ?? url;
  if (label === "package_url" || label === "project_url") return "Package page";
  if (label === "release_url") return "Release page";
  return label;
}

function scoreJsonLink(path: string[], url: string, pageUrl: string, keywords: string[]): number {
  let score = 0;
  const joinedPath = path.join(".").toLowerCase();
  const label = prettyJsonLabel(path, url);
  const lowerLabel = label.toLowerCase();
  const lowerUrl = url.toLowerCase();

  if (/\.urls\.\d+\.url$/.test(joinedPath)) return Number.NEGATIVE_INFINITY;

  for (const pattern of JSON_URL_KEY_PATTERNS) {
    if (pattern.test(joinedPath) || pattern.test(lowerLabel)) score += 12;
  }
  if (joinedPath.startsWith("info.project_urls")) score += 18;
  if (joinedPath.endsWith("package_url") || joinedPath.endsWith("project_url") || joinedPath.endsWith("release_url")) score += 10;
  score += countKeywordMatches(`${joinedPath} ${lowerLabel} ${lowerUrl}`, keywords) * 6;

  try {
    const parsed = new URL(url);
    const page = new URL(pageUrl);
    if (parsed.host === page.host) score += 6;
    if (["github.com", "docs.", "readthedocs.io", "pypi.org"].some((token) => parsed.host.includes(token))) score += 4;
  } catch {
    return Number.NEGATIVE_INFINITY;
  }

  return score;
}

function collectJsonLinks(value: unknown, path: string[], pageUrl: string, keywords: string[], out: Map<string, ScoredRelevantLink>): void {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^https?:\/\//.test(trimmed)) return;

    const text = prettyJsonLabel(path, trimmed);
    const score = scoreJsonLink(path, trimmed, pageUrl, keywords);
    if (!Number.isFinite(score) || score < MIN_LINK_SCORE) return;

    const existing = out.get(trimmed);
    const current: ScoredRelevantLink = {
      text,
      url: trimmed,
      score,
      index: out.size,
      canonicalLabelScore: 0,
    };
    if (!existing || current.score > existing.score) out.set(trimmed, current);
    return;
  }

  if (Array.isArray(value)) {
    value.slice(0, 40).forEach((item, i) => collectJsonLinks(item, [...path, String(i)], pageUrl, keywords, out));
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value).slice(0, 100)) {
      collectJsonLinks(child, [...path, key], pageUrl, keywords, out);
    }
  }
}

export function extractRelevantLinksFromJson(data: unknown, pageUrl: string, prompt?: string): RelevantLink[] {
  const keywords = tokenizeText(prompt);
  const byUrl = new Map<string, ScoredRelevantLink>();
  collectJsonLinks(data, [], pageUrl, keywords, byUrl);

  return [...byUrl.values()]
    .sort((a, b) => b.score - a.score || a.text.localeCompare(b.text) || a.url.localeCompare(b.url))
    .slice(0, MAX_RELEVANT_LINKS)
    .map(({ text, url }) => ({ text, url }));
}
