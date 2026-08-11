/**
 * Browse tool — fetch and read web pages.
 *
 * Fetches a URL, converts HTML to markdown, then passes the content
 * through a provider-aware inner LLM call to produce a focused summary.
 * For this experiment, the inner summarizer itself is asked to include a
 * final markdown Relevant Links section instead of using deterministic link
 * extraction. Caches converted readable pages for 15 minutes. Handles HTML,
 * JSON, and plain text content types. Attachments, binary responses, and
 * explicit mode=download requests are saved to the conversation workspace
 * instead of being sent to the inner LLM.
 */

import type { Tool, ToolResult, ToolSummary, ToolExecutionContext } from "./types";
import { cap, getString, summarizeParams } from "./util";
import { htmlToMarkdown } from "./html";
import { complete } from "../llm";
import { formatToolAbortMessage, isAbortLikeError } from "../abort";
import { log } from "../log";
import { getInnerLlmSummaryOptions } from "./inner-llm";
import { createHash } from "node:crypto";
import {
  downloadResponse,
  normalizedContentType,
  shouldDownloadResponse,
  type DownloadedFile,
} from "./browse-download";
import {
  fetchPageWithVimbrowser,
  type VimbrowserPageFetcher,
} from "./browse-vimbrowser";

// ── Constants ──────────────────────────────────────────────────────

const CACHE_TTL = 15 * 60 * 1000; // 15 minutes
const MAX_CACHE_ENTRIES = 50;
const SUMMARY_CACHE_TTL = 15 * 60 * 1000; // 15 minutes
const MAX_SUMMARY_CACHE_ENTRIES = 100;
const BROWSE_USER_AGENT = "Mozilla/5.0 (compatible; Exocortex/1.0)";
const BROWSE_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const BROWSE_MAX_TOKENS = 4096;
const SUMMARY_MARKDOWN_MAX_CHARS = 200_000;
const SUMMARY_MARKDOWN_HEAD_CHARS = 160_000;
const SUMMARY_MARKDOWN_TAIL_CHARS = SUMMARY_MARKDOWN_MAX_CHARS - SUMMARY_MARKDOWN_HEAD_CHARS;
const BLOCKED_CRATES_PATTERN = /API data access policy/i;

interface CachedPage {
  content: string;
  pageUrl: string;
  ts: number;
}

interface CachedSummary {
  content: string;
  ts: number;
}

interface FetchedPage {
  markdown: string;
  pageUrl: string;
}

type BrowseMode = "auto" | "download";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface BrowseDependencies {
  fetch: FetchLike;
  summarize: typeof summarizeContent;
  vimbrowserFetch?: VimbrowserPageFetcher;
}

// ── Cache ──────────────────────────────────────────────────────────

const fetchCache = new Map<string, CachedPage>();
const summaryCache = new Map<string, CachedSummary>();

function cleanCache(): void {
  const now = Date.now();
  for (const [key, entry] of fetchCache) {
    if (now - entry.ts > CACHE_TTL) fetchCache.delete(key);
  }
  for (const [key, entry] of summaryCache) {
    if (now - entry.ts > SUMMARY_CACHE_TTL) summaryCache.delete(key);
  }
}

function evictOldest<T extends { ts: number }>(cache: Map<string, T>): void {
  let oldestKey: string | null = null;
  let oldestTs = Infinity;
  for (const [key, entry] of cache) {
    if (entry.ts < oldestTs) {
      oldestTs = entry.ts;
      oldestKey = key;
    }
  }
  if (oldestKey !== null) cache.delete(oldestKey);
}

function setCacheEntry(url: string, pageUrl: string, content: string): void {
  // Evict the oldest entry by timestamp when at capacity.
  if (fetchCache.size >= MAX_CACHE_ENTRIES) {
    evictOldest(fetchCache);
  }

  fetchCache.set(url, { content, pageUrl, ts: Date.now() });
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function prepareMarkdownForSummary(markdown: string): string {
  if (markdown.length <= SUMMARY_MARKDOWN_MAX_CHARS) return markdown;

  const omitted = markdown.length - SUMMARY_MARKDOWN_MAX_CHARS;
  return [
    markdown.slice(0, SUMMARY_MARKDOWN_HEAD_CHARS),
    `\n\n---\n[Browse note: omitted ${omitted.toLocaleString()} characters from the middle of this large page to keep summarization fast. The end of the page follows.]\n---\n\n`,
    markdown.slice(-SUMMARY_MARKDOWN_TAIL_CHARS),
  ].join("");
}

function getSummaryCacheEntry(key: string): string | null {
  cleanCache();
  const cached = summaryCache.get(key);
  if (!cached) return null;
  return cached.content;
}

function setSummaryCacheEntry(key: string, content: string): void {
  if (summaryCache.size >= MAX_SUMMARY_CACHE_ENTRIES) evictOldest(summaryCache);
  summaryCache.set(key, { content, ts: Date.now() });
}

function buildSummaryHeader(url: string, prompt?: string): string {
  return prompt
    ? `URL: ${url}\nLooking for: ${prompt}\n\n---\n\n`
    : `URL: ${url}\nProvide a general summary.\n\n---\n\n`;
}

function fallbackRawContent(url: string, markdown: string, prompt?: string): string {
  const header = prompt
    ? `Content from ${url} (looking for: ${prompt}):\n\n`
    : `Content from ${url}:\n\n`;
  return header + markdown;
}

function blockedAccessSummary(pageUrl: string, markdown: string): string | null {
  try {
    const page = new URL(pageUrl);
    if (page.host === "crates.io" && BLOCKED_CRATES_PATTERN.test(markdown)) {
      return [
        `Summary of ${pageUrl}:`,
        "",
        "This page did not return the crate details. crates.io responded with an access-policy block message instead of the normal crate page.",
        "",
        "The visible response says the request appears to violate the crates.io API/data-access policy and directs the reader to the policy page for guidance.",
      ].join("\n");
    }
  } catch {
    // Ignore invalid URLs here.
  }
  return null;
}

function normalizeBrowseUrl(url: string): string {
  return url.startsWith("http://") ? `https://${url.slice(7)}` : url;
}

function ensureSameHostRedirect(originalUrl: URL, finalUrl: string): ToolResult | null {
  try {
    const finalParsed = new URL(finalUrl);
    if (finalParsed.host !== originalUrl.host) {
      return {
        output: `URL redirected to a different host: ${finalUrl}\nPlease make a new browse request with the redirect URL.`,
        isError: false,
      };
    }
  } catch {
    // Ignore malformed redirect URLs and proceed with the fetched response.
  }
  return null;
}

function responseBodyToMarkdown(rawBody: string, contentType: string, pageUrl: string): string {
  if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
    return htmlToMarkdown(rawBody, pageUrl);
  }

  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(rawBody);
      return `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
    } catch {
      return rawBody;
    }
  }

  return rawBody;
}

function downloadsDisabledResult(contentType = "unknown content type"): ToolResult {
  return {
    output: `The URL points to a downloadable file (${contentType || "unknown content type"}), but downloads are disabled in this read-only session. Use the browse tool in the main conversation to save it.`,
    isError: false,
  };
}

async function fetchPage(
  fetchUrl: string,
  originalUrl: URL,
  mode: BrowseMode,
  context: ToolExecutionContext | undefined,
  fetchImpl: FetchLike,
  vimbrowserFetch?: VimbrowserPageFetcher,
  signal?: AbortSignal,
): Promise<FetchedPage | DownloadedFile | ToolResult> {
  log("info", `browse: fetching ${fetchUrl}`);
  const res = await fetchImpl(fetchUrl, {
    headers: {
      "User-Agent": BROWSE_USER_AGENT,
      Accept: BROWSE_ACCEPT,
    },
    redirect: "follow",
    signal,
    tls: { rejectUnauthorized: false },
  } as RequestInit & { tls?: { rejectUnauthorized: boolean } });

  const finalUrl = res.url || fetchUrl;
  const crossHostRedirect = res.url ? ensureSameHostRedirect(originalUrl, res.url) : null;
  if (crossHostRedirect) return crossHostRedirect;

  if (res.status === 403 && mode === "download" && vimbrowserFetch?.download) {
    await res.body?.cancel().catch(() => {});
    if (context?.allowDownloads === false) {
      return downloadsDisabledResult(normalizedContentType(res.headers));
    }
    log("info", `browse: direct download returned HTTP 403; trying vimbrowser for ${finalUrl}`);
    try {
      const browserDownload = await vimbrowserFetch.download(
        finalUrl,
        context?.cwd ?? process.cwd(),
        signal,
      );
      if (browserDownload) {
        if ("redirectUrl" in browserDownload) {
          return ensureSameHostRedirect(originalUrl, browserDownload.redirectUrl) ?? {
            output: `Error: unexpected browser download redirect to ${browserDownload.redirectUrl}`,
            isError: true,
          };
        }
        log("info", `browse: vimbrowser downloaded ${browserDownload.pageUrl} (${browserDownload.bytes} bytes)`);
        return browserDownload;
      }
      log("debug", "browse: vimbrowser download fallback is unavailable");
    } catch (error) {
      if (signal?.aborted || isAbortLikeError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      log("warn", `browse: vimbrowser download fallback failed (${message})`);
    }
  }

  if (res.status === 403 && mode === "auto" && vimbrowserFetch) {
    await res.body?.cancel().catch(() => {});
    log("info", `browse: direct fetch returned HTTP 403; trying vimbrowser for ${finalUrl}`);
    try {
      const browserPage = await vimbrowserFetch(finalUrl, signal);
      if (browserPage) {
        const browserRedirect = ensureSameHostRedirect(originalUrl, browserPage.pageUrl);
        if (browserRedirect) return browserRedirect;
        log("info", `browse: vimbrowser fallback loaded ${browserPage.pageUrl} (${browserPage.html.length} chars)`);
        return {
          markdown: responseBodyToMarkdown(browserPage.html, "text/html", browserPage.pageUrl),
          pageUrl: browserPage.pageUrl,
        };
      }
      log("debug", "browse: vimbrowser fallback is unavailable");
    } catch (error) {
      if (signal?.aborted || isAbortLikeError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      log("warn", `browse: vimbrowser fallback failed (${message})`);
    }
  }

  if (!res.ok) {
    return { output: `Error fetching ${fetchUrl}: HTTP ${res.status} ${res.statusText}`, isError: true };
  }

  if (mode === "download" || shouldDownloadResponse(res.headers, finalUrl)) {
    if (context?.allowDownloads === false) {
      await res.body?.cancel().catch(() => {});
      return downloadsDisabledResult(normalizedContentType(res.headers));
    }
    return downloadResponse(res, finalUrl, context?.cwd ?? process.cwd(), signal);
  }

  const rawBody = await res.text();
  const markdown = responseBodyToMarkdown(rawBody, res.headers.get("content-type") ?? "", finalUrl);
  return {
    markdown,
    pageUrl: finalUrl,
  };
}

async function getPageContent(
  fetchUrl: string,
  originalUrl: URL,
  mode: BrowseMode,
  context: ToolExecutionContext | undefined,
  fetchImpl: FetchLike,
  vimbrowserFetch?: VimbrowserPageFetcher,
  signal?: AbortSignal,
): Promise<FetchedPage | DownloadedFile | ToolResult> {
  if (mode === "auto") {
    cleanCache();
    const cached = fetchCache.get(fetchUrl);
    if (cached) {
      log("debug", `browse: cache hit for ${fetchUrl}`);
      return { markdown: cached.content, pageUrl: cached.pageUrl };
    }
  }

  const fetched = await fetchPage(fetchUrl, originalUrl, mode, context, fetchImpl, vimbrowserFetch, signal);
  if ("isError" in fetched) return fetched;

  if ("downloadPath" in fetched) return fetched;

  if (mode === "auto") setCacheEntry(fetchUrl, fetched.pageUrl, fetched.markdown);
  return fetched;
}

// ── LLM summarization ─────────────────────────────────────────────

const SUMMARIZE_SYSTEM = [
  "You are a web page digestor. You receive the markdown content of a web page and a user prompt describing what they're looking for.",
  "Your job:",
  "- Produce a focused, useful digest of the markdown that directly addresses the user's prompt.",
  "- Prefer concise answers; include detail when the prompt asks for it or the page needs it for accuracy.",
  "- At the very end of your response, include a markdown section exactly titled: ## Relevant Links, then include links you consider relevant. Max 7 links.",
  "- For each link, use markdown numbered-list format: 1. [Title](URL)",
  "- Mention links inline if you think they are important to understanding the page; keep the dedicated Relevant Links section for follow-up exploration.",
  "- Output markdown.",
].join("\n");

async function summarizeContent(
  url: string,
  markdown: string,
  prompt?: string,
  context?: ToolExecutionContext,
  signal?: AbortSignal,
): Promise<string> {
  const summaryMarkdown = prepareMarkdownForSummary(markdown);
  const userMessage = buildSummaryHeader(url, prompt) + summaryMarkdown;

  try {
    const llmOptions = getInnerLlmSummaryOptions(context);
    const cacheKey = JSON.stringify({
      provider: llmOptions.provider,
      model: llmOptions.model,
      effort: llmOptions.effort,
      serviceTier: llmOptions.serviceTier ?? null,
      prompt: prompt ?? "",
      url,
      markdownHash: hashText(summaryMarkdown),
    });
    const cached = getSummaryCacheEntry(cacheKey);
    if (cached) {
      log("debug", `browse: summary cache hit for ${url}`);
      return cached;
    }

    log("info", `browse: summarizing ${url} (${summaryMarkdown.length}/${markdown.length} chars) with ${llmOptions.provider}/${llmOptions.model} effort=${llmOptions.effort} serviceTier=${llmOptions.serviceTier ?? "default"}`);
    const result = await complete(SUMMARIZE_SYSTEM, userMessage, {
      ...llmOptions,
      maxTokens: BROWSE_MAX_TOKENS,
      signal,
      tracking: {
        source: "browse_summary",
        ...(context?.conversationId ? { conversationId: context.conversationId } : {}),
      },
    });
    log("info", `browse: summary done (${result.text.length} chars, in=${result.inputTokens ?? "?"}, out=${result.outputTokens ?? "?"})`);
    const summary = `Summary of ${url}:\n\n${result.text}`;
    setSummaryCacheEntry(cacheKey, summary);
    return summary;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("warn", `browse: summarization failed (${msg}), returning raw content`);
    return fallbackRawContent(url, markdown, prompt);
  }
}

// ── Execution ──────────────────────────────────────────────────────

async function executeBrowse(
  input: Record<string, unknown>,
  context?: ToolExecutionContext,
  signal?: AbortSignal,
  dependencies: BrowseDependencies = {
    fetch: globalThis.fetch,
    summarize: summarizeContent,
    vimbrowserFetch: fetchPageWithVimbrowser,
  },
): Promise<ToolResult> {
  const url = getString(input, "url");
  const prompt = getString(input, "prompt");
  const requestedMode = input.mode;

  if (!url) return { output: "Error: missing 'url' parameter", isError: true };
  if (requestedMode !== undefined && requestedMode !== "auto" && requestedMode !== "download") {
    return { output: "Error: 'mode' must be either 'auto' or 'download'", isError: true };
  }
  const mode: BrowseMode = requestedMode === "download" ? "download" : "auto";

  const fetchUrl = normalizeBrowseUrl(url);

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(fetchUrl);
  } catch {
    return { output: `Error: invalid URL: ${url}`, isError: true };
  }

  const startTime = Date.now();
  try {
    const page = await getPageContent(
      fetchUrl,
      parsedUrl,
      mode,
      context,
      dependencies.fetch,
      dependencies.vimbrowserFetch,
      signal,
    );
    if ("isError" in page) return page;
    if ("downloadPath" in page) {
      const typeLabel = page.contentType || "unknown content type";
      return {
        output: [
          `Downloaded ${page.pageUrl} to ${page.downloadPath} (${page.bytes.toLocaleString()} bytes, ${typeLabel}).`,
          `SHA-256: ${page.sha256}`,
        ].join("\n"),
        isError: false,
      };
    }
    if (!page.markdown.trim()) {
      return { output: "The page returned no content.", isError: false };
    }

    const blockedSummary = blockedAccessSummary(page.pageUrl, page.markdown);
    if (blockedSummary) {
      return { output: cap(blockedSummary), isError: false };
    }

    const summary = await dependencies.summarize(page.pageUrl, page.markdown, prompt, context, signal);
    return { output: cap(summary), isError: false };
  } catch (err) {
    if (signal?.aborted || isAbortLikeError(err)) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      return { output: formatToolAbortMessage(signal, elapsed), isError: false };
    }

    const msg = err instanceof Error ? err.message : String(err);
    log("error", `browse: ${msg}`);
    return { output: `Error browsing ${fetchUrl}: ${msg}`, isError: true };
  }
}

// ── Summary ────────────────────────────────────────────────────────

function summarize(input: Record<string, unknown>): ToolSummary {
  const url = getString(input, "url") ?? "";
  return { label: "Browse", detail: summarizeParams(url, input, ["url"]) };
}

// ── Tool definition ────────────────────────────────────────────────

export const browse: Tool = {
  name: "browse",
  description: "Read content from a URL or save its exact response payload. Supports web pages, feeds, APIs, community sites, and CDN files.",
  parallelSafety: "exclusive",
  defaultTimeoutMs: 120_000,
  settleOnAbort: true,
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to browse" },
      prompt: { type: "string", description: "What to look for or extract from the page" },
      mode: {
        type: "string",
        enum: ["auto", "download"],
        description: "auto (default) digests readable content and saves attachments/binary responses; download saves the complete response payload regardless of MIME type without AI interpretation",
      },
    },
    required: ["url"],
  },
  systemHint: "Browse uses an inner AI call to parse web-readable responses in auto mode. Use mode=download whenever the complete response must be preserved, including text, JavaScript, JSON, or source code; it saves the payload to the conversation workspace without AI interpretation and reports its path and SHA-256. Attachments and binary responses are also saved automatically. On HTTP 403, browse may retry in a dedicated inactive tab of the running vimbrowser profile, using its browser fingerprint, cookies, and site storage; the tab is reset afterward. Adjust the prompt to your needs.",
  display: {
    label: "Browse",
    color: "#50c8c8",  // teal
  },
  summarize,
  execute: executeBrowse,
};

export const browseInternalsForTest = {
  executeBrowse,
};
