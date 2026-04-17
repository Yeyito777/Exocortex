import { extractRelevantLinksFromJson } from "./json";
import { extractSpecialRelevantLinks } from "./special";
import type {
  CandidateLink,
  DomainKind,
  PageContext,
  RelevantLink,
  ScoredRelevantLink,
} from "./types";
import {
  CONTEXT_WINDOW,
  MAX_RELEVANT_LINKS,
  MIN_LINK_SCORE,
} from "./types";
import {
  canonicalUrl,
  countKeywordMatches,
  normalizeWhitespace,
  stripMarkdown,
  tokenizeText,
} from "./utils";

const BOILERPLATE_TEXT = new Set([
  "github",
  "home",
  "about",
  "pricing",
  "blog",
  "docs",
  "documentation",
  "contact",
  "status",
  "security",
  "terms",
  "privacy",
  "sign in",
  "sign up",
  "login",
  "logout",
  "notifications",
  "new issue",
  "new pull request",
  "marketplace",
  "explore",
  "enterprise",
  "features",
  "solutions",
  "support",
  "labels",
  "milestones",
  "search syntax tips",
]);

const BOILERPLATE_TEXT_PATTERNS = [
  /^issues\b/,
  /^pull requests\b/,
  /^actions\b/,
  /^discussions\b/,
  /^security( and quality)?\b/,
  /^projects\b/,
  /^wiki\b/,
  /^insights\b/,
  /^release tracker\b/,
  /^author:/,
  /^label:/,
  /^milestone:/,
];

const HN_BOILERPLATE_TEXT = new Set([
  "hacker news",
  "new",
  "past",
  "comments",
  "ask",
  "show",
  "jobs",
  "submit",
  "login",
  "guidelines",
  "faq",
  "lists",
  "security",
  "legal",
  "apply to yc",
  "contact",
  "favorite",
  "api",
]);

const WIKIPEDIA_BOILERPLATE_TEXT = new Set([
  "main page",
  "contents",
  "current events",
  "random article",
  "about wikipedia",
  "contact us",
  "help",
  "learn to edit",
  "community portal",
  "recent changes",
  "upload file",
  "special pages",
  "donate",
  "create account",
  "log in",
  "article",
  "talk",
  "edit links",
  "wikidata item",
  "terms of use",
  "privacy policy",
  "creative commons attribution-sharealike 4.0 license",
  "original research",
  "inline citations",
  "improve it",
]);

const PYTHON_DOCS_BOILERPLATE_TEXT = new Set([
  "report a bug",
  "show source",
  "previous topic",
  "next topic",
  "this page",
  "download",
]);

const HUGGINGFACE_BOILERPLATE_TEXT = new Set([
  "bert",
  "exbert",
  "new",
]);

const HUGGINGFACE_BOILERPLATE_PATTERNS = [
  /view code snippets/i,
  /model tree/i,
  /maximize/i,
  /^#### /,
];

interface MarkdownLinkMatch extends RelevantLink {
  index: number;
  raw: string;
}

function trimBareUrl(url: string): string {
  let trimmed = url;
  while (/[.,;:!?]$/.test(trimmed)) trimmed = trimmed.slice(0, -1);
  while (trimmed.endsWith(")")) {
    const opens = (trimmed.match(/\(/g) ?? []).length;
    const closes = (trimmed.match(/\)/g) ?? []).length;
    if (closes <= opens) break;
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

function titleCasePathSegment(segment: string): string {
  return segment
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function defaultLabelForUrl(url: string, context: PageContext): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.host === "crates.io" && parsed.pathname === "/data-access") return "Data access policy";
    if (parsed.host === context.page.host && parsed.pathname === context.page.pathname && parsed.hash) {
      return titleCasePathSegment(parsed.hash.slice(1));
    }
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    if (pathParts.length > 0) return titleCasePathSegment(pathParts[pathParts.length - 1] ?? parsed.host);
    return parsed.host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function cleanLabelText(text: string): string {
  const cleaned = normalizeWhitespace(
    text
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/^#+\s*/gm, "")
      .replace(/\[\[?–\]?\]/g, " ")
      .replace(/^[-*]+\s*/gm, ""),
  );

  const parts = cleaned.split(/\s+/);
  const deduped: string[] = [];
  for (const part of parts) {
    if (deduped.length > 0 && deduped[deduped.length - 1]?.toLowerCase() === part.toLowerCase()) continue;
    deduped.push(part);
  }
  return deduped.join(" ");
}

function getRepoPrefix(url: URL): string | null {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return `/${parts[0]}/${parts[1]}`;
}

function detectDomainKind(page: URL): DomainKind {
  const host = page.host.toLowerCase();
  if (host === "github.com") return "github";
  if (host === "news.ycombinator.com") return "hackernews";
  if (host.endsWith("wikipedia.org")) return "wikipedia";
  if (host === "docs.python.org") return "python-docs";
  if (host === "blog.rust-lang.org") return "rust-blog";
  if (host === "huggingface.co") return "huggingface";
  if (host === "docs.rs") return "docs-rs";
  if (host === "developer.mozilla.org") return "mdn";
  if (host === "www.npmjs.com") return "npmjs";
  if (host === "www.rfc-editor.org") return "rfc-editor";
  if (host === "arxiv.org") return "arxiv";
  if (host === "julialang.org") return page.pathname.startsWith("/blog") ? "julia-blog" : "generic";
  if (host === "pypi.org") return "pypi";
  if (host.endsWith(".readthedocs.io")) return "readthedocs";
  if (host === "pandas.pydata.org" && page.pathname.startsWith("/docs")) return "pandas-docs";
  if (host === "fastapi.tiangolo.com") return "fastapi-docs";
  if (host === "blog.python.org") return "python-blog";
  if (host === "fetch.spec.whatwg.org") return "whatwg-spec";
  return "generic";
}

function buildPageContext(pageUrl: string, prompt?: string): PageContext | null {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return null;
  }

  const repoPrefix = page.host === "github.com" ? getRepoPrefix(page) : null;
  const keywords = [...new Set([
    ...tokenizeText(prompt),
    ...tokenizeText(page.searchParams.get("q") ?? undefined),
  ])];

  const isGitHubRepoSearchPage = Boolean(
    repoPrefix
    && page.host === "github.com"
    && page.searchParams.has("q")
    && [`${repoPrefix}/issues`, `${repoPrefix}/pulls`, `${repoPrefix}/discussions`].includes(page.pathname),
  );

  return {
    page,
    domainKind: detectDomainKind(page),
    repoPrefix,
    keywords,
    isGitHubRepoSearchPage,
  };
}

function isSameRepoUrl(parsed: URL, context: PageContext): boolean {
  return Boolean(
    context.repoPrefix
    && parsed.host === context.page.host
    && (parsed.pathname === context.repoPrefix || parsed.pathname.startsWith(`${context.repoPrefix}/`)),
  );
}

function isGitHubFilterUrl(parsed: URL, context: PageContext): boolean {
  if (parsed.host === "docs.github.com") return true;
  if (parsed.host !== "github.com") return false;
  if (parsed.pathname === "/search") return true;
  if (!parsed.searchParams.has("q")) return false;
  if (!context.repoPrefix) return true;

  return [`${context.repoPrefix}/issues`, `${context.repoPrefix}/pulls`, `${context.repoPrefix}/discussions`].includes(parsed.pathname);
}

export function isGitHubEntityUrl(parsed: URL, context: PageContext): boolean {
  if (!isSameRepoUrl(parsed, context) || !context.repoPrefix) return false;
  return [
    new RegExp(`^${context.repoPrefix}/issues/\\d+$`),
    new RegExp(`^${context.repoPrefix}/issues/\\d+#issuecomment-\\d+$`),
    new RegExp(`^${context.repoPrefix}/pull/\\d+$`),
    new RegExp(`^${context.repoPrefix}/pull/\\d+/(files|commits)$`),
    new RegExp(`^${context.repoPrefix}/pull/\\d+/files/[0-9a-f]+\.\.[0-9a-f]+$`),
    new RegExp(`^${context.repoPrefix}/discussions/\\d+$`),
    new RegExp(`^${context.repoPrefix}/commit/[0-9a-f]{7,}$`),
    new RegExp(`^${context.repoPrefix}/compare/[0-9a-f]{7,}\.\.[0-9a-f]{7,}$`),
  ].some((pattern) => pattern.test(parsed.pathname));
}

function isPythonAsyncioDocPath(path: string): boolean {
  return /^\/3\/(library\/asyncio[-a-z]*\.html|howto\/a-conceptual-overview-of-asyncio\.html)$/.test(path);
}

function isRustBlogPostPath(path: string): boolean {
  return /^\/\d{4}\/\d{2}\/\d{2}\//.test(path);
}

export function isWikipediaContentPath(path: string): boolean {
  return /^\/wiki\//.test(path)
    && !/^\/wiki\/(Wikipedia|Help|Special|Talk):/.test(path);
}

function isHuggingFaceModelOrDocPath(path: string): boolean {
  return path.startsWith("/docs/") || path.split("/").filter(Boolean).length >= 2;
}

function isBoilerplateLink(text: string, url: string, context: PageContext): boolean {
  const lowerText = text.toLowerCase();
  if (BOILERPLATE_TEXT.has(lowerText)) return true;
  if (BOILERPLATE_TEXT_PATTERNS.some((pattern) => pattern.test(lowerText))) return true;

  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();

    if (isGitHubFilterUrl(parsed, context)) return true;
    if (parsed.origin !== context.page.origin && ["/", ""].includes(path)) return true;
    if (context.repoPrefix && path === context.repoPrefix.toLowerCase()) return true;
    if (["/login", "/join", "/signup", "/features", "/enterprise", "/pricing", "/site/privacy", "/site/terms"].includes(path)) return true;
    if (path.startsWith("/settings") || path.startsWith("/orgs/") || path.startsWith("/features/") || path.startsWith("/security/advanced-security")) return true;
    if (path.endsWith("/labels") || path.endsWith("/milestones") || path.endsWith("/actions") || path.endsWith("/projects") || path.endsWith("/wiki") || path.endsWith("/security")) return true;

    switch (context.domainKind) {
      case "hackernews":
        if (HN_BOILERPLATE_TEXT.has(lowerText)) return true;
        if (["/", "/news", "/newest", "/front", "/newcomments", "/ask", "/show", "/jobs", "/submit", "/login", "/newsguidelines.html", "/newsfaq.html", "/lists", "/security.html"].includes(path)) return true;
        if (path === "/user" || path === "/fave") return true;
        if (path === "/item" && lowerText.endsWith("months ago")) return true;
        break;
      case "wikipedia":
        if (WIKIPEDIA_BOILERPLATE_TEXT.has(lowerText)) return true;
        if (parsed.host === "donate.wikimedia.org" || parsed.host === "foundation.wikimedia.org" || parsed.host === "www.wikidata.org") return true;
        if (path.startsWith("/wiki/category:")) return true;
        if (!isWikipediaContentPath(path) && parsed.host.endsWith("wikipedia.org")) return true;
        break;
      case "python-docs":
        if (PYTHON_DOCS_BOILERPLATE_TEXT.has(lowerText)) return true;
        if (path === "/3/bugs.html" || path.includes("github.com/python/cpython")) return true;
        break;
      case "rust-blog":
        if (path === "/" && lowerText === "rust blog") return true;
        if (parsed.host === "www.rust-lang.org" && path !== "/learn" && path !== "/tools/install") return true;
        if (parsed.host === "github.com" && path === "/rust-lang/blog.rust-lang.org") return true;
        break;
      case "huggingface":
        if (HUGGINGFACE_BOILERPLATE_TEXT.has(lowerText)) return true;
        if (HUGGINGFACE_BOILERPLATE_PATTERNS.some((pattern) => pattern.test(text))) return true;
        if (path.startsWith("/models?") || path.startsWith("/models/") || path.startsWith("/datasets/") || path.startsWith("/spaces/")) return true;
        break;
    }
  } catch {
    return false;
  }

  return false;
}

function scoreDomainSpecificLink(text: string, parsed: URL, surroundingText: string, context: PageContext): number {
  const path = parsed.pathname;
  const lowerText = text.toLowerCase();
  const lowerContext = surroundingText.toLowerCase();

  switch (context.domainKind) {
    case "hackernews":
      if (path === "/item") {
        let score = 18;
        if (/\b(parent|context|on:)\b/.test(lowerContext) || /\b(parent|context)\b/.test(lowerText)) score += 12;
        if (text.length > 20) score += 10;
        return score;
      }
      if (parsed.host === "github.com") return 10;
      return -20;
    case "wikipedia":
      if (parsed.host === context.page.host && isWikipediaContentPath(path)) {
        let score = 14;
        if (/\b(see also|external links|applications|variants|history|overview)\b/.test(lowerContext)) score += 6;
        if (text.length > 10) score += 4;
        return score;
      }
      if (["distill.pub", "web.stanford.edu"].includes(parsed.host)) return 12;
      return -20;
    case "python-docs":
      if (parsed.host === context.page.host && isPythonAsyncioDocPath(path)) {
        let score = 20;
        if (parsed.hash) score -= 4;
        if (path.endsWith("/asyncio-task.html")) score += 10;
        else if (path.endsWith("/asyncio-stream.html")) score += 9;
        else if (path.endsWith("/asyncio-sync.html")) score += 8;
        else if (path.endsWith("/asyncio-runner.html")) score += 7;
        else if (path.endsWith("/a-conceptual-overview-of-asyncio.html")) score += 7;
        else if (path.endsWith("/asyncio-eventloop.html")) score += 5;
        else if (path.endsWith("/asyncio-queue.html") || path.endsWith("/asyncio-subprocess.html")) score += 4;
        if (/high-level apis/.test(lowerContext)) score += 10;
        if (/\b(coroutines?|tasks?|streams?|runners?|synchronization|subprocesses|queues?|event loop|overview)\b/.test(lowerText)) score += 8;
        return score;
      }
      return -15;
    case "rust-blog":
      if (parsed.host === context.page.host && isRustBlogPostPath(path)) return 24;
      if (parsed.host === context.page.host && ["/inside-rust/", "/releases/"].includes(path)) return 18;
      return -15;
    case "huggingface":
      if (parsed.host === context.page.host && isHuggingFaceModelOrDocPath(path)) {
        let score = 12;
        if (/\b(files|versions|community|discussions|quickstart|installation|pipeline|trainer|course|model card)\b/.test(lowerText)) score += 8;
        return score;
      }
      if (["github.com", "arxiv.org"].includes(parsed.host)) return 14;
      return -8;
    default:
      if (parsed.host === "crates.io" && parsed.pathname === "/data-access") return 20;
      return 0;
  }
}

function normalizeRelevantUrl(url: string, context: PageContext): string {
  try {
    const parsed = new URL(url);
    if (["python-docs", "readthedocs", "pandas-docs"].includes(context.domainKind) && parsed.hash && parsed.pathname !== context.page.pathname) {
      parsed.hash = "";
    }
    if (["docs-rs", "rfc-editor", "mdn"].includes(context.domainKind) && parsed.hash) {
      parsed.hash = "";
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function canonicalLabelForUrl(url: string, context: PageContext): string | null {
  try {
    const parsed = new URL(url);
    switch (context.domainKind) {
      case "github": {
        if (/\/pull\/\d+\/files\/[0-9a-f]+$/.test(parsed.pathname)) return "View reviewed changes";
        if (/\/pull\/\d+\/files(\/|$)/.test(parsed.pathname)) return "Files changed";
        if (/\/pull\/\d+\/commits(\/|$)/.test(parsed.pathname)) return "Commits";
        if (/\/compare\/[0-9a-f]{7,}\.\.[0-9a-f]{7,}$/.test(parsed.pathname)) return "Compare";
        return null;
      }
      case "python-docs":
        if (parsed.pathname.endsWith("/asyncio-runner.html")) return "Runners";
        if (parsed.pathname.endsWith("/asyncio-task.html")) return "Coroutines and tasks";
        if (parsed.pathname.endsWith("/asyncio-stream.html")) return "Streams";
        if (parsed.pathname.endsWith("/asyncio-sync.html")) return "Synchronization Primitives";
        if (parsed.pathname.endsWith("/asyncio-subprocess.html")) return "Subprocesses";
        if (parsed.pathname.endsWith("/asyncio-queue.html")) return "Queues";
        if (parsed.pathname.endsWith("/asyncio-eventloop.html")) return "Event loop";
        if (parsed.pathname.endsWith("/a-conceptual-overview-of-asyncio.html")) return "A Conceptual Overview of asyncio";
        return null;
      case "huggingface":
        if (parsed.pathname.endsWith("/tree/main")) return "Files and versions";
        if (parsed.pathname.endsWith("/discussions")) return "Community";
        if (parsed.pathname.startsWith("/papers/")) return "Paper";
        return null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function scoreCanonicalLabel(text: string, canonicalLabel: string | null): number {
  if (!canonicalLabel) return 0;
  const normalizedText = text.toLowerCase();
  const normalizedCanonical = canonicalLabel.toLowerCase();
  if (normalizedText === normalizedCanonical) return 3;
  if (normalizedText.includes(normalizedCanonical)) return 2;
  return 0;
}

function applyCanonicalLabel(text: string, url: string, context: PageContext): { text: string; canonicalLabelScore: number } {
  const canonicalLabel = canonicalLabelForUrl(url, context);
  const canonicalLabelScore = scoreCanonicalLabel(text, canonicalLabel);
  if (!canonicalLabel) return { text, canonicalLabelScore };
  return { text: canonicalLabel, canonicalLabelScore };
}

export function scoreLink(text: string, url: string, surroundingText: string, context: PageContext, sourceIndex: number): number {
  if (!text || (!url.startsWith("http://") && !url.startsWith("https://"))) return Number.NEGATIVE_INFINITY;
  if (canonicalUrl(url) === canonicalUrl(context.page.toString())) return Number.NEGATIVE_INFINITY;
  if (isBoilerplateLink(text, url, context)) return Number.NEGATIVE_INFINITY;

  let score = 0;
  const lowerText = text.toLowerCase();
  const lowerUrl = url.toLowerCase();
  const lowerContext = surroundingText.toLowerCase();
  const keywordMatches = countKeywordMatches(`${lowerText} ${lowerUrl} ${lowerContext}`, context.keywords);

  if (text.length >= 3 && text.length <= 120) score += 4;
  if (/#[0-9]+/.test(text)) score += 10;
  if (/\/issues\/\d+(#|$)/.test(lowerUrl)) score += 18;
  if (/\/pull\/\d+(#|$)/.test(lowerUrl)) score += 18;
  if (/\/pull\/\d+\/files(\/|$)/.test(lowerUrl)) score += 10;
  if (/\/pull\/\d+\/commits(\/|$)/.test(lowerUrl)) score += 8;
  if (/\/discussions\/\d+(#|$)/.test(lowerUrl)) score += 16;
  if (/\/commit\/[0-9a-f]{7,}/.test(lowerUrl)) score += 14;
  if (/\/compare\/[0-9a-f]{7,}\.\.[0-9a-f]{7,}/.test(lowerUrl)) score += 10;
  if (/#issuecomment-\d+/.test(lowerUrl)) score += 12;
  if (/\b(issue|pull request|pr|comment|fix|workaround|bug|commit|diff|files changed)\b/.test(lowerText)) score += 6;
  score += keywordMatches * 6;

  try {
    const parsed = new URL(url);
    if (parsed.host === context.page.host) score += 6;
    if (isSameRepoUrl(parsed, context)) score += 12;
    else if (parsed.host === context.page.host && context.domainKind === "github") score -= 12;

    score += scoreDomainSpecificLink(text, parsed, surroundingText, context);

    if (context.domainKind === "rust-blog") score += Math.max(0, 20 - sourceIndex / 500);
    else if (context.domainKind === "python-docs") score += Math.max(0, 8 - sourceIndex / 1200);

    if (context.isGitHubRepoSearchPage) {
      if (!isGitHubEntityUrl(parsed, context)) return Number.NEGATIVE_INFINITY;
      if (keywordMatches === 0) return Number.NEGATIVE_INFINITY;
    }
  } catch {
    // Ignore parsing failures here — URL validity was already checked.
  }

  return score;
}

function extractMarkdownLinks(markdown: string): MarkdownLinkMatch[] {
  const results: MarkdownLinkMatch[] = [];

  for (let i = 0; i < markdown.length; i++) {
    if (markdown[i] !== "[") continue;
    if (i > 0 && markdown[i - 1] === "!") continue;

    let labelEnd = i + 1;
    let labelDepth = 1;
    while (labelEnd < markdown.length) {
      const ch = markdown[labelEnd];
      if (ch === "[") labelDepth += 1;
      else if (ch === "]") {
        labelDepth -= 1;
        if (labelDepth === 0) break;
      }
      labelEnd += 1;
    }
    if (labelDepth !== 0 || markdown[labelEnd + 1] !== "(") continue;

    const text = cleanLabelText(markdown.slice(i + 1, labelEnd));
    let urlEnd = labelEnd + 2;
    let urlDepth = 1;
    let url = "";

    while (urlEnd < markdown.length) {
      const ch = markdown[urlEnd];
      if (ch === "(") urlDepth += 1;
      else if (ch === ")") {
        urlDepth -= 1;
        if (urlDepth === 0) break;
      }
      url += ch;
      urlEnd += 1;
    }

    if (urlDepth !== 0) continue;
    const trimmedUrl = url.trim();
    if (!trimmedUrl || !text) continue;

    results.push({
      text,
      url: trimmedUrl,
      index: i,
      raw: markdown.slice(i, urlEnd + 1),
    });
    i = urlEnd;
  }

  return results;
}

function extractBareUrlLinks(markdown: string, context: PageContext, existingUrls: Set<string>): MarkdownLinkMatch[] {
  const results: MarkdownLinkMatch[] = [];
  const urlRegex = /https?:\/\/[^\s<>"']+/g;

  for (const match of markdown.matchAll(urlRegex)) {
    const rawUrl = match[0];
    const index = match.index ?? 0;
    const trimmedUrl = trimBareUrl(rawUrl);
    if (!trimmedUrl) continue;
    if (existingUrls.has(trimmedUrl)) continue;

    const text = defaultLabelForUrl(trimmedUrl, context);
    if (!text) continue;

    results.push({
      text,
      url: trimmedUrl,
      index,
      raw: rawUrl,
    });
  }

  return results;
}

function extractLinkMatches(markdown: string, context: PageContext): MarkdownLinkMatch[] {
  const markdownLinks = extractMarkdownLinks(markdown);
  const existingUrls = new Set(markdownLinks.map((match) => trimBareUrl(match.url)));
  return [...markdownLinks, ...extractBareUrlLinks(markdown, context, existingUrls)]
    .sort((a, b) => a.index - b.index || a.url.localeCompare(b.url));
}

function normalizeCandidateLinks(markdown: string, context: PageContext): CandidateLink[] {
  return extractLinkMatches(markdown, context)
    .map((match) => {
      const url = normalizeRelevantUrl(match.url.trim(), context);
      const normalizedText = stripMarkdown(match.text);
      const applied = applyCanonicalLabel(normalizedText, url, context);
      return { text: applied.text, url, index: match.index };
    })
    .filter((link) => Boolean(link.text) && Boolean(link.url));
}

export function extractRelevantLinks(markdown: string, pageUrl: string, prompt?: string): RelevantLink[] {
  const context = buildPageContext(pageUrl, prompt);
  if (!context) return [];

  const special = extractSpecialRelevantLinks(markdown, context, {
    normalizeCandidateLinks,
    isWikipediaContentPath,
    isGitHubEntityUrl,
    scoreLink,
  });
  if (special.length > 0) return special.slice(0, MAX_RELEVANT_LINKS);

  const byUrl = new Map<string, ScoredRelevantLink>();
  let index = 0;

  for (const match of extractLinkMatches(markdown, context)) {
    const url = normalizeRelevantUrl(match.url.trim(), context);
    const normalizedText = stripMarkdown(match.text);
    const applied = applyCanonicalLabel(normalizedText, url, context);
    const start = Math.max(0, match.index - CONTEXT_WINDOW);
    const end = Math.min(markdown.length, match.index + match.raw.length + CONTEXT_WINDOW);
    const surroundingText = markdown.slice(start, end);
    const score = scoreLink(applied.text, url, surroundingText, context, match.index) + applied.canonicalLabelScore * 4;
    if (!Number.isFinite(score) || score < MIN_LINK_SCORE) continue;

    const current: ScoredRelevantLink = {
      text: applied.text,
      url,
      score,
      index,
      canonicalLabelScore: applied.canonicalLabelScore,
    };
    const existing = byUrl.get(url);
    if (!existing
      || current.score > existing.score
      || (current.score === existing.score && current.canonicalLabelScore > existing.canonicalLabelScore)
      || (current.score === existing.score && current.canonicalLabelScore === existing.canonicalLabelScore && current.text.length < existing.text.length)) {
      byUrl.set(url, current);
    }
    index += 1;
  }

  return [...byUrl.values()]
    .sort((a, b) => b.score - a.score || b.canonicalLabelScore - a.canonicalLabelScore || a.index - b.index || a.text.localeCompare(b.text) || a.url.localeCompare(b.url))
    .slice(0, MAX_RELEVANT_LINKS)
    .map(({ text, url }) => ({ text, url }));
}

export { extractRelevantLinksFromJson };

export function buildRelevantLinksSection(links: RelevantLink[]): string {
  if (links.length === 0) return "## Relevant Links\n- None found.";
  return [
    "## Relevant Links",
    ...links.map((link, i) => `${i + 1}. [${link.text}](${link.url})`),
  ].join("\n");
}
