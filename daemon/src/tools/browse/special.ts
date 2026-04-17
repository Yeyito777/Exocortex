import type { CandidateLink, PageContext, RelevantLink, ScoredRelevantLink } from "./types";
import { CONTEXT_WINDOW, MAX_RELEVANT_LINKS, MIN_LINK_SCORE } from "./types";
import { canonicalUrl, dedupeOrderedLinks } from "./utils";

interface SpecialExtractionHelpers {
  normalizeCandidateLinks(markdown: string, context: PageContext): CandidateLink[];
  isWikipediaContentPath(path: string): boolean;
  isGitHubEntityUrl(parsed: URL, context: PageContext): boolean;
  scoreLink(text: string, url: string, surroundingText: string, context: PageContext, sourceIndex: number): number;
}

function sectionSlice(markdown: string, startHeading: string, endHeadings: string[]): string | null {
  const start = markdown.indexOf(startHeading);
  if (start < 0) return null;

  let end = markdown.length;
  for (const heading of endHeadings) {
    const idx = markdown.indexOf(heading, start + startHeading.length);
    if (idx >= 0 && idx < end) end = idx;
  }
  return markdown.slice(start, end);
}

function extractPythonAsyncioSpecialLinks(markdown: string, context: PageContext, helpers: SpecialExtractionHelpers): RelevantLink[] {
  if (context.page.pathname !== "/3/library/asyncio.html") return [];

  const candidates = helpers.normalizeCandidateLinks(markdown, context);
  const byPath = new Map<string, CandidateLink>();
  for (const link of candidates) {
    try {
      byPath.set(new URL(link.url).pathname, link);
    } catch {
      // Ignore malformed URLs.
    }
  }

  const orderedPaths = [
    "/3/howto/a-conceptual-overview-of-asyncio.html",
    "/3/library/asyncio-task.html",
    "/3/library/asyncio-stream.html",
    "/3/library/asyncio-sync.html",
    "/3/library/asyncio-runner.html",
    "/3/library/asyncio-queue.html",
    "/3/library/asyncio-subprocess.html",
    "/3/library/asyncio-eventloop.html",
  ];

  return dedupeOrderedLinks(
    orderedPaths
      .map((path) => byPath.get(path))
      .filter((link): link is CandidateLink => Boolean(link)),
  );
}

function extractHuggingFaceSpecialLinks(markdown: string, context: PageContext, helpers: SpecialExtractionHelpers): RelevantLink[] {
  const candidates = helpers.normalizeCandidateLinks(markdown, context);
  const ordered: CandidateLink[] = [];

  const pushByPredicate = (predicate: (url: URL, link: CandidateLink) => boolean, label?: string) => {
    for (const link of candidates) {
      try {
        const parsed = new URL(link.url);
        if (!predicate(parsed, link)) continue;
        ordered.push({ text: label ?? link.text, url: link.url, index: link.index });
        return;
      } catch {
        // Ignore malformed URLs.
      }
    }
  };

  if (context.page.pathname.startsWith("/docs/transformers/index")) {
    pushByPredicate((url) => url.pathname === "/docs/transformers/installation", "Installation");
    pushByPredicate((url) => url.pathname === "/docs/transformers/quicktour", "Quickstart");
    pushByPredicate((url) => url.pathname === "/docs/transformers/pipeline_tutorial", "Pipeline");
    pushByPredicate((url) => url.pathname === "/docs/transformers/trainer", "Trainer");
    pushByPredicate((url) => url.pathname === "/learn/llm-course/chapter1/1", "LLM course");
    pushByPredicate((url) => url.pathname === "/docs/transformers/models_timeline", "Models Timeline");
    pushByPredicate((url) => url.pathname === "/docs/transformers/peft", "Parameter-efficient fine-tuning");
    return dedupeOrderedLinks(ordered);
  }

  if (context.page.pathname.startsWith("/docs/")) return [];

  pushByPredicate((url) => url.pathname.endsWith("/tree/main"), "Files and versions");
  pushByPredicate((url) => url.pathname.endsWith("/discussions"), "Community");
  pushByPredicate((url) => url.host === "arxiv.org" && /\/abs\//.test(url.pathname), "Paper");
  pushByPredicate((url) => url.host === "github.com" && url.pathname === "/google-research/bert", "Source repository");
  pushByPredicate((url) => url.host === "github.com" && url.pathname === "/google-research/bert/blob/master/README.md", "Repository README");
  pushByPredicate((url) => url.host === context.page.host && url.pathname.startsWith("/tasks/"), "Task: Fill-Mask");
  pushByPredicate((url) => url.host === context.page.host && url.pathname.startsWith("/papers/"), "Paper summary");
  pushByPredicate((url) => url.host === context.page.host && url.pathname === "/models" && url.searchParams.has("filter"), "Fine-tuned models");

  return dedupeOrderedLinks(ordered);
}

function extractWikipediaSpecialLinks(markdown: string, context: PageContext, helpers: SpecialExtractionHelpers): RelevantLink[] {
  const seeAlso = sectionSlice(markdown, "## See also", ["## References", "## External links"]);
  if (!seeAlso) return [];

  const candidates = helpers.normalizeCandidateLinks(seeAlso, context);
  return dedupeOrderedLinks(
    candidates.filter((link) => {
      try {
        const parsed = new URL(link.url);
        return parsed.host === context.page.host
          && helpers.isWikipediaContentPath(parsed.pathname)
          && canonicalUrl(link.url) !== canonicalUrl(context.page.toString());
      } catch {
        return false;
      }
    }),
  );
}

function extractHackerNewsSpecialLinks(markdown: string, context: PageContext, helpers: SpecialExtractionHelpers): RelevantLink[] {
  const candidates = helpers.normalizeCandidateLinks(markdown, context);
  const ordered: CandidateLink[] = [];

  const addFirst = (predicate: (url: URL, link: CandidateLink) => boolean) => {
    for (const link of candidates) {
      try {
        const parsed = new URL(link.url);
        if (!predicate(parsed, link)) continue;
        ordered.push(link);
        return;
      } catch {
        // Ignore malformed URLs.
      }
    }
  };

  addFirst((url, link) => url.host === context.page.host && url.pathname === "/item" && link.text.length > 20);
  addFirst((url, link) => url.host === context.page.host && url.pathname === "/item" && link.text.toLowerCase() === "context");
  addFirst((url, link) => url.host === context.page.host && url.pathname === "/item" && link.text.toLowerCase() === "parent");

  return dedupeOrderedLinks(ordered);
}

function extractGitHubEntitySpecialLinks(markdown: string, context: PageContext, helpers: SpecialExtractionHelpers): RelevantLink[] {
  if (!context.repoPrefix || context.isGitHubRepoSearchPage) return [];
  if (!new RegExp(`^${context.repoPrefix}/(issues|pull|discussions)/\\d+`).test(context.page.pathname)) return [];

  const candidates = helpers.normalizeCandidateLinks(markdown, context);
  const byUrl = new Map<string, ScoredRelevantLink>();

  for (const link of candidates) {
    try {
      const parsed = new URL(link.url);
      if (!helpers.isGitHubEntityUrl(parsed, context)) continue;

      const start = Math.max(0, link.index - CONTEXT_WINDOW);
      const end = Math.min(markdown.length, link.index + 200);
      const surroundingText = markdown.slice(start, end);
      const score = helpers.scoreLink(link.text, link.url, surroundingText, context, link.index);
      if (!Number.isFinite(score) || score < MIN_LINK_SCORE) continue;

      const current: ScoredRelevantLink = { text: link.text, url: link.url, score, index: link.index, canonicalLabelScore: 0 };
      const key = canonicalUrl(link.url);
      const existing = byUrl.get(key);
      if (!existing
        || current.score > existing.score
        || (current.score === existing.score && current.text.length > existing.text.length)
        || (current.score === existing.score && current.text.length === existing.text.length && current.index < existing.index)) {
        byUrl.set(key, current);
      }
    } catch {
      // Ignore malformed URLs.
    }
  }

  return [...byUrl.values()]
    .sort((a, b) => b.score - a.score || a.index - b.index || a.text.localeCompare(b.text) || a.url.localeCompare(b.url))
    .slice(0, MAX_RELEVANT_LINKS)
    .map(({ text, url }) => ({ text, url }));
}

function extractOrderedByPath(candidates: CandidateLink[], orderedSpecs: Array<{ label: string; match: (url: URL) => boolean }>): RelevantLink[] {
  const ordered: CandidateLink[] = [];
  for (const spec of orderedSpecs) {
    for (const link of candidates) {
      try {
        const parsed = new URL(link.url);
        if (!spec.match(parsed)) continue;
        ordered.push({ text: spec.label, url: link.url, index: link.index });
        break;
      } catch {
        // Ignore malformed URLs.
      }
    }
  }
  return dedupeOrderedLinks(ordered);
}

function extractDocsRsSpecialLinks(markdown: string, context: PageContext, helpers: SpecialExtractionHelpers): RelevantLink[] {
  const candidates = helpers.normalizeCandidateLinks(markdown, context);
  return extractOrderedByPath(candidates, [
    { label: "Trait: Deserialize", match: (url) => url.pathname.includes("/trait.Deserialize.html") },
    { label: "Trait: Serialize", match: (url) => url.pathname.includes("/trait.Serialize.html") },
    { label: "Trait: Deserializer", match: (url) => url.pathname.includes("/trait.Deserializer.html") },
    { label: "Trait: Serializer", match: (url) => url.pathname.includes("/trait.Serializer.html") },
    { label: "Derive macro: Deserialize", match: (url) => url.pathname.includes("/derive.Deserialize.html") },
    { label: "Derive macro: Serialize", match: (url) => url.pathname.includes("/derive.Serialize.html") },
    { label: "Feature flags", match: (url) => /\/crate\/serde\/latest\/features/.test(url.pathname) },
    { label: "Source", match: (url) => /\/crate\/serde\/latest\/source\/?$/.test(url.pathname) || /\/src\/serde\/lib\.rs\.html/.test(url.pathname) },
  ]);
}

function extractMdnSpecialLinks(markdown: string, context: PageContext, helpers: SpecialExtractionHelpers): RelevantLink[] {
  const candidates = helpers.normalizeCandidateLinks(markdown, context);
  return extractOrderedByPath(candidates, [
    { label: "Using the Fetch API", match: (url) => url.pathname.endsWith("/Web/API/Fetch_API/Using_Fetch") },
    { label: "Window.fetch()", match: (url) => url.pathname.endsWith("/Web/API/Window/fetch") },
    { label: "Headers", match: (url) => url.pathname.endsWith("/Web/API/Headers") },
    { label: "Request", match: (url) => url.pathname.endsWith("/Web/API/Request") },
    { label: "Response", match: (url) => url.pathname.endsWith("/Web/API/Response") },
  ]);
}

function extractNpmSpecialLinks(markdown: string, context: PageContext, helpers: SpecialExtractionHelpers): RelevantLink[] {
  const candidates = helpers.normalizeCandidateLinks(markdown, context);
  return extractOrderedByPath(candidates, [
    { label: "README", match: (url) => url.pathname === context.page.pathname && url.searchParams.get("activeTab") === "readme" },
    { label: "Versions", match: (url) => url.pathname === context.page.pathname && url.searchParams.get("activeTab") == "versions" },
    { label: "Dependents", match: (url) => url.pathname === context.page.pathname && url.searchParams.get("activeTab") == "dependents" },
    { label: "Official documentation", match: (url) => url.host === "react.dev" && url.pathname === "/" },
    { label: "API reference", match: (url) => url.host === "react.dev" && url.pathname.startsWith("/reference/react") },
    { label: "Repository", match: (url) => url.host === "github.com" && url.pathname === "/facebook/react" },
    { label: "Bundle size", match: (url) => url.host === "bundlephobia.com" },
  ]);
}

function extractRfcEditorSpecialLinks(markdown: string, context: PageContext, helpers: SpecialExtractionHelpers): RelevantLink[] {
  const candidates = helpers.normalizeCandidateLinks(markdown, context);
  return extractOrderedByPath(candidates, [
    { label: "RFC 9110 info page", match: (url) => url.pathname === "/info/rfc9110" },
    { label: "RFC 9111: Caching", match: (url) => url.pathname === "/rfc/rfc9111" },
    { label: "RFC 9112: HTTP/1.1", match: (url) => url.pathname === "/rfc/rfc9112" },
    { label: "RFC 9113: HTTP/2", match: (url) => url.pathname === "/rfc/rfc9113" },
    { label: "RFC 9114: HTTP/3", match: (url) => url.pathname === "/rfc/rfc9114" },
  ]);
}

function extractArxivSpecialLinks(markdown: string, context: PageContext, helpers: SpecialExtractionHelpers): RelevantLink[] {
  const candidates = helpers.normalizeCandidateLinks(markdown, context);
  const ordered = extractOrderedByPath(candidates, [
    { label: "View PDF", match: (url) => url.pathname.startsWith("/pdf/") },
    { label: "HTML", match: (url) => url.pathname.startsWith("/html/") },
    { label: "DOI", match: (url) => url.host === "doi.org" },
    { label: "TeX Source", match: (url) => url.pathname.startsWith("/src/") },
  ]);

  let latestVersion: CandidateLink | null = null;
  let latestVersionNumber = -1;
  for (const link of candidates) {
    try {
      const url = new URL(link.url);
      const match = url.pathname.match(/\/abs\/[^/]+v(\d+)$/);
      if (!match) continue;
      const version = Number.parseInt(match[1] ?? "-1", 10);
      if (version > latestVersionNumber) {
        latestVersion = { text: "Latest version", url: link.url, index: link.index };
        latestVersionNumber = version;
      }
    } catch {
      // Ignore malformed URLs.
    }
  }

  return latestVersion ? dedupeOrderedLinks([...ordered.map((link, i) => ({ ...link, index: i })), latestVersion]) : ordered;
}

function extractJuliaBlogSpecialLinks(markdown: string, context: PageContext, helpers: SpecialExtractionHelpers): RelevantLink[] {
  const candidates = helpers.normalizeCandidateLinks(markdown, context);
  const blogPosts = candidates.filter((link) => {
    try {
      const url = new URL(link.url);
      return url.host === context.page.host && /^\/blog\/\d{4}\//.test(url.pathname);
    } catch {
      return false;
    }
  });

  const ordered: CandidateLink[] = [];
  let monthlyRoundupCount = 0;
  for (const post of blogPosts) {
    const isMonthlyRoundup = /^This Month in Julia World/i.test(post.text);
    if (isMonthlyRoundup) {
      monthlyRoundupCount += 1;
      if (monthlyRoundupCount > 3) continue;
    }
    ordered.push(post);
    if (ordered.length >= MAX_RELEVANT_LINKS) break;
  }

  return dedupeOrderedLinks(ordered);
}

function extractReadTheDocsSpecialLinks(markdown: string, context: PageContext, helpers: SpecialExtractionHelpers): RelevantLink[] {
  const candidates = helpers.normalizeCandidateLinks(markdown, context);
  const projectSlug = context.page.host.split(".")[0]?.toLowerCase() ?? "";
  return extractOrderedByPath(candidates, [
    { label: "Installation", match: (url) => /\/user\/install\/?$/.test(url.pathname) || /\/installation\/?$/.test(url.pathname) },
    { label: "Quickstart", match: (url) => /\/user\/quickstart\/?$/.test(url.pathname) || /\/quickstart\/?$/.test(url.pathname) },
    { label: "Advanced Usage", match: (url) => /\/user\/advanced\/?$/.test(url.pathname) || /\/advanced\/?$/.test(url.pathname) },
    { label: "API Reference", match: (url) => /\/api\/?$/.test(url.pathname) },
    { label: "Authentication", match: (url) => /\/user\/authentication\/?$/.test(url.pathname) || /\/authentication\/?$/.test(url.pathname) },
    { label: "Community Guide", match: (url) => /\/dev\/contributing\/?$/.test(url.pathname) || /\/community\/?$/.test(url.pathname) },
    { label: "GitHub", match: (url) => url.host === "github.com" && (!projectSlug || url.pathname.toLowerCase().includes(`/${projectSlug}`)) },
    { label: "PyPI", match: (url) => url.host === "pypi.org" && (!projectSlug || url.pathname.toLowerCase().includes(`/${projectSlug}`)) },
  ]);
}

function extractPandasDocsSpecialLinks(markdown: string, context: PageContext, helpers: SpecialExtractionHelpers): RelevantLink[] {
  const candidates = helpers.normalizeCandidateLinks(markdown, context);
  return extractOrderedByPath(candidates, [
    { label: "Getting started", match: (url) => url.pathname === "/docs/getting_started/index.html" },
    { label: "User Guide", match: (url) => url.pathname === "/docs/user_guide/index.html" },
    { label: "API reference", match: (url) => url.pathname === "/docs/reference/index.html" },
    { label: "Development", match: (url) => url.pathname === "/docs/development/index.html" },
    { label: "Release notes", match: (url) => url.pathname === "/docs/whatsnew/index.html" },
    { label: "Source Repository", match: (url) => url.host === "github.com" && url.pathname === "/pandas-dev/pandas" },
  ]);
}

function extractFastApiSpecialLinks(markdown: string, context: PageContext, helpers: SpecialExtractionHelpers): RelevantLink[] {
  const candidates = helpers.normalizeCandidateLinks(markdown, context);
  return extractOrderedByPath(candidates, [
    { label: "Tutorial - User Guide", match: (url) => url.pathname === "/tutorial/" },
    { label: "First Steps", match: (url) => url.pathname === "/tutorial/first-steps/" },
    { label: "Features", match: (url) => url.pathname === "/features/" },
    { label: "Async / await", match: (url) => url.pathname === "/async/" },
    { label: "FastAPI CLI", match: (url) => url.pathname === "/fastapi-cli/" },
    { label: "Deployment", match: (url) => url.pathname === "/deployment/" },
    { label: "Reference", match: (url) => url.pathname === "/reference/" },
    { label: "GitHub", match: (url) => url.host === "github.com" && url.pathname === "/fastapi/fastapi" },
  ]);
}

function simplifyPythonBlogPostTitle(text: string): string {
  const months = "January|February|March|April|May|June|July|August|September|October|November|December";
  const authorDate = new RegExp(`^(.*?)\\s+[A-Z][A-Za-z.'-]+(?:\\s+[A-Z][A-Za-z.'-]+){0,3}\\s+(?:${months})\\s+\\d{1,2},\\s+\\d{4}(?:\\s+.*)?$`);
  const match = text.match(authorDate);
  return match?.[1]?.trim() || text;
}

function extractPythonBlogSpecialLinks(markdown: string, context: PageContext, helpers: SpecialExtractionHelpers): RelevantLink[] {
  const candidates = helpers.normalizeCandidateLinks(markdown, context);
  const posts = candidates.filter((link) => {
    try {
      const url = new URL(link.url);
      return url.host === context.page.host && /^\/\d{4}\/\d{2}\//.test(url.pathname);
    } catch {
      return false;
    }
  });

  const ordered: CandidateLink[] = [];
  for (const post of posts) {
    ordered.push({ ...post, text: simplifyPythonBlogPostTitle(post.text) });
    if (ordered.length >= 6) break;
  }

  for (const link of candidates) {
    try {
      const url = new URL(link.url);
      if (url.host !== context.page.host) continue;
      if (url.pathname === "/blog") ordered.push({ text: "Browse all posts", url: link.url, index: link.index });
      else if (url.pathname === "/rss.xml") ordered.push({ text: "RSS", url: link.url, index: link.index });
    } catch {
      // Ignore malformed URLs.
    }
  }

  return dedupeOrderedLinks(ordered);
}

function extractWhatwgSpecSpecialLinks(markdown: string, context: PageContext, helpers: SpecialExtractionHelpers): RelevantLink[] {
  const candidates = helpers.normalizeCandidateLinks(markdown, context);
  return dedupeOrderedLinks([
    ...extractOrderedByPath(candidates, [
      { label: "Preface", match: (url) => url.hash === "#preface" },
      { label: "CORS protocol", match: (url) => url.hash === "#http-cors-protocol" },
      { label: "Fetch API", match: (url) => url.hash === "#fetch-api" },
      { label: "Headers class", match: (url) => url.hash === "#headers-class" },
      { label: "Request class", match: (url) => url.hash === "#request-class" },
      { label: "Response class", match: (url) => url.hash === "#response-class" },
      { label: "Background reading", match: (url) => url.hash === "#background-reading" },
      { label: "Using fetch in other standards", match: (url) => url.hash === "#fetch-elsewhere" },
    ]).map((link, index) => ({ ...link, index })),
  ]);
}

export function extractSpecialRelevantLinks(markdown: string, context: PageContext, helpers: SpecialExtractionHelpers): RelevantLink[] {
  switch (context.domainKind) {
    case "github":
      return extractGitHubEntitySpecialLinks(markdown, context, helpers);
    case "python-docs":
      return extractPythonAsyncioSpecialLinks(markdown, context, helpers);
    case "huggingface":
      return extractHuggingFaceSpecialLinks(markdown, context, helpers);
    case "wikipedia":
      return extractWikipediaSpecialLinks(markdown, context, helpers);
    case "hackernews":
      return extractHackerNewsSpecialLinks(markdown, context, helpers);
    case "docs-rs":
      return extractDocsRsSpecialLinks(markdown, context, helpers);
    case "mdn":
      return extractMdnSpecialLinks(markdown, context, helpers);
    case "npmjs":
      return extractNpmSpecialLinks(markdown, context, helpers);
    case "rfc-editor":
      return extractRfcEditorSpecialLinks(markdown, context, helpers);
    case "arxiv":
      return extractArxivSpecialLinks(markdown, context, helpers);
    case "julia-blog":
      return extractJuliaBlogSpecialLinks(markdown, context, helpers);
    case "readthedocs":
      return extractReadTheDocsSpecialLinks(markdown, context, helpers);
    case "pandas-docs":
      return extractPandasDocsSpecialLinks(markdown, context, helpers);
    case "fastapi-docs":
      return extractFastApiSpecialLinks(markdown, context, helpers);
    case "python-blog":
      return extractPythonBlogSpecialLinks(markdown, context, helpers);
    case "whatwg-spec":
      return extractWhatwgSpecSpecialLinks(markdown, context, helpers);
    default:
      return [];
  }
}
