/**
 * Browse tool — fetch and read web pages.
 *
 * Fetches a URL, converts HTML to markdown, then passes the content
 * through a provider-aware inner LLM call to produce a focused summary.
 * For this experiment, the inner summarizer itself is asked to include a
 * final markdown Relevant Links section instead of using deterministic link
 * extraction. Caches raw fetches for 15 minutes. Handles HTML, JSON, and
 * plain text content types.
 */

import type { Tool, ToolResult, ToolSummary, ToolExecutionContext } from "./types";
import { cap, getString, summarizeParams } from "./util";
import { htmlToMarkdown } from "./html";
import { complete } from "../llm";
import { log } from "../log";
import { getInnerLlmSummaryOptions } from "./inner-llm";

// ── Constants ──────────────────────────────────────────────────────

const CACHE_TTL = 15 * 60 * 1000; // 15 minutes
const MAX_CACHE_ENTRIES = 50;
const BROWSE_USER_AGENT = "Mozilla/5.0 (compatible; Exocortex/1.0)";
const BROWSE_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const BROWSE_MAX_TOKENS = 8192;
const BLOCKED_CRATES_PATTERN = /API data access policy/i;

interface CachedPage {
  content: string;
  pageUrl: string;
  ts: number;
}

interface FetchedPage {
  markdown: string;
  pageUrl: string;
}

// ── Cache ──────────────────────────────────────────────────────────

const fetchCache = new Map<string, CachedPage>();

function cleanCache(): void {
  const now = Date.now();
  for (const [key, entry] of fetchCache) {
    if (now - entry.ts > CACHE_TTL) fetchCache.delete(key);
  }
}

function setCacheEntry(url: string, pageUrl: string, content: string): void {
  // Evict the oldest entry by timestamp when at capacity.
  if (fetchCache.size >= MAX_CACHE_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestTs = Infinity;
    for (const [key, entry] of fetchCache) {
      if (entry.ts < oldestTs) {
        oldestTs = entry.ts;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) fetchCache.delete(oldestKey);
  }

  fetchCache.set(url, { content, pageUrl, ts: Date.now() });
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

async function fetchPage(fetchUrl: string, originalUrl: URL, signal?: AbortSignal): Promise<FetchedPage | ToolResult> {
  log("info", `browse: fetching ${fetchUrl}`);
  const res = await fetch(fetchUrl, {
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

  if (!res.ok) {
    return { output: `Error fetching ${fetchUrl}: HTTP ${res.status} ${res.statusText}`, isError: true };
  }

  const rawBody = await res.text();
  return {
    markdown: responseBodyToMarkdown(rawBody, res.headers.get("content-type") ?? "", finalUrl),
    pageUrl: finalUrl,
  };
}

async function getPageContent(fetchUrl: string, originalUrl: URL, signal?: AbortSignal): Promise<FetchedPage | ToolResult> {
  cleanCache();
  const cached = fetchCache.get(fetchUrl);
  if (cached) {
    log("debug", `browse: cache hit for ${fetchUrl}`);
    return { markdown: cached.content, pageUrl: cached.pageUrl };
  }

  const fetched = await fetchPage(fetchUrl, originalUrl, signal);
  if ("isError" in fetched) return fetched;

  setCacheEntry(fetchUrl, fetched.pageUrl, fetched.markdown);
  return fetched;
}

// ── LLM summarization ─────────────────────────────────────────────

const SUMMARIZE_SYSTEM = [
  "You are a web page digestor. You receive the markdown content of a web page and a user prompt describing what they're looking for.",
  "Your job:",
  "- Produce an extensive, and thorough digest of the markdown that addresses the user's prompt.",
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
  const userMessage = buildSummaryHeader(url, prompt) + markdown;

  try {
    const llmOptions = getInnerLlmSummaryOptions(context);
    log("info", `browse: summarizing ${url} (${markdown.length} chars) with ${llmOptions.provider}/${llmOptions.model}`);
    const result = await complete(SUMMARIZE_SYSTEM, userMessage, {
      ...llmOptions,
      maxTokens: BROWSE_MAX_TOKENS,
      signal,
    });
    log("info", `browse: summary done (${result.text.length} chars, in=${result.inputTokens ?? "?"}, out=${result.outputTokens ?? "?"})`);
    return `Summary of ${url}:\n\n${result.text}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("warn", `browse: summarization failed (${msg}), returning raw content`);
    return fallbackRawContent(url, markdown, prompt);
  }
}

// ── Execution ──────────────────────────────────────────────────────

async function executeBrowse(input: Record<string, unknown>, context?: ToolExecutionContext, signal?: AbortSignal): Promise<ToolResult> {
  const url = getString(input, "url");
  const prompt = getString(input, "prompt");

  if (!url) return { output: "Error: missing 'url' parameter", isError: true };

  const fetchUrl = normalizeBrowseUrl(url);

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(fetchUrl);
  } catch {
    return { output: `Error: invalid URL: ${url}`, isError: true };
  }

  const startTime = Date.now();
  try {
    const page = await getPageContent(fetchUrl, parsedUrl, signal);
    if ("isError" in page) return page;
    if (!page.markdown.trim()) {
      return { output: "The page returned no content.", isError: false };
    }

    const blockedSummary = blockedAccessSummary(page.pageUrl, page.markdown);
    if (blockedSummary) {
      return { output: cap(blockedSummary), isError: false };
    }

    const summary = await summarizeContent(page.pageUrl, page.markdown, prompt, context, signal);
    return { output: cap(summary), isError: false };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      return { output: `User interrupted after ${elapsed}s of execution.`, isError: false };
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
  description: "Read content from a URL. Supports web pages, feeds, APIs, and community sites.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to browse" },
      prompt: { type: "string", description: "What to look for or extract from the page" },
    },
    required: ["url", "prompt"],
  },
  systemHint: "Browse tool uses an inner AI call to parse a markdown rendered version of the requested website before relaying relevant information to you. Adjust the prompt to your needs.",
  display: {
    label: "Browse",
    color: "#50c8c8",  // teal
  },
  summarize,
  execute: executeBrowse,
};
