/**
 * Browse tool — fetch and read web pages.
 *
 * Fetches a URL, converts HTML to markdown, then passes the content
 * through an inner LLM call (sonnet) to produce a focused summary
 * with relevant links preserved. Caches raw fetches for 15 minutes.
 * Handles HTML, JSON, and plain text content types.
 */

import type { Tool, ToolResult, ToolSummary } from "./types";
import { cap, getString, summarizeParams } from "./util";
import { htmlToMarkdown } from "./html";
import { complete } from "../llm";
import { log } from "../log";

// ── Constants ──────────────────────────────────────────────────────

const CACHE_TTL = 15 * 60 * 1000; // 15 minutes
const MAX_CACHE_ENTRIES = 50;

// ── Cache ──────────────────────────────────────────────────────────

const fetchCache = new Map<string, { content: string; ts: number }>();

function cleanCache(): void {
  const now = Date.now();
  for (const [key, entry] of fetchCache) {
    if (now - entry.ts > CACHE_TTL) fetchCache.delete(key);
  }
}

function setCacheEntry(url: string, content: string): void {
  // Evict the oldest entry by timestamp when at capacity
  if (fetchCache.size >= MAX_CACHE_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestTs = Infinity;
    for (const [k, v] of fetchCache) {
      if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
    }
    if (oldestKey !== null) fetchCache.delete(oldestKey);
  }
  fetchCache.set(url, { content, ts: Date.now() });
}

// ── LLM summarization ─────────────────────────────────────────────

const SUMMARIZE_SYSTEM = [
  "You are a web page summarizer. You receive the markdown content of a web page and a user prompt describing what they're looking for.",
  "Your job:",
  "- Produce a clear, focused summary that addresses the user's prompt.",
  "- Preserve all relevant URLs as markdown links — the reader needs them to navigate.",
  "- If the page contains code snippets relevant to the prompt, include them.",
  "- Omit navigation boilerplate, ads, cookie banners, and other noise.",
  "- Keep the summary concise but complete. Don't omit important details.",
  "- Output markdown.",
].join("\n");

async function summarizeContent(url: string, markdown: string, prompt?: string, signal?: AbortSignal): Promise<string> {
  const userMessage = prompt
    ? `URL: ${url}\nLooking for: ${prompt}\n\n---\n\n${markdown}`
    : `URL: ${url}\nProvide a general summary.\n\n---\n\n${markdown}`;

  try {
    log("info", `browse: summarizing ${url} (${markdown.length} chars) with sonnet`);
    const result = await complete(SUMMARIZE_SYSTEM, userMessage, {
      model: "sonnet",
      maxTokens: 8192,
      signal,
    });
    log("info", `browse: summary done (${result.text.length} chars, in=${result.inputTokens ?? "?"}, out=${result.outputTokens ?? "?"})`);
    return `Summary of ${url}:\n\n${result.text}`;
  } catch (err) {
    // If the inner LLM call fails, fall back to raw content
    const msg = err instanceof Error ? err.message : String(err);
    log("warn", `browse: summarization failed (${msg}), returning raw content`);
    const header = prompt
      ? `Content from ${url} (looking for: ${prompt}):\n\n`
      : `Content from ${url}:\n\n`;
    return header + markdown;
  }
}

// ── Execution ──────────────────────────────────────────────────────

async function executeBrowse(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const url = getString(input, "url");
  const prompt = getString(input, "prompt");

  if (!url) return { output: "Error: missing 'url' parameter", isError: true };

  // Upgrade HTTP to HTTPS
  let fetchUrl = url;
  if (fetchUrl.startsWith("http://")) {
    fetchUrl = "https://" + fetchUrl.slice(7);
  }

  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(fetchUrl);
  } catch {
    return { output: `Error: invalid URL: ${url}`, isError: true };
  }

  const startTime = Date.now();
  try {
    // Check cache
    cleanCache();
    const cached = fetchCache.get(fetchUrl);
    let markdown: string;

    if (cached) {
      log("debug", `browse: cache hit for ${fetchUrl}`);
      markdown = cached.content;
    } else {
      log("info", `browse: fetching ${fetchUrl}`);
      const res = await fetch(fetchUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; Exocortex/1.0)",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        redirect: "follow",
        signal,
        tls: { rejectUnauthorized: false },
      } as RequestInit & { tls?: { rejectUnauthorized: boolean } });

      // Check for cross-host redirects
      const finalUrl = res.url;
      if (finalUrl) {
        try {
          const finalParsed = new URL(finalUrl);
          if (finalParsed.host !== parsedUrl.host) {
            return {
              output: `URL redirected to a different host: ${finalUrl}\nPlease make a new browse request with the redirect URL.`,
              isError: false,
            };
          }
        } catch { /* malformed redirect URL — ignore, proceed with response */ }
      }

      if (!res.ok) {
        return { output: `Error fetching ${fetchUrl}: HTTP ${res.status} ${res.statusText}`, isError: true };
      }

      const contentType = res.headers.get("content-type") ?? "";
      const rawBody = await res.text();

      if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
        markdown = htmlToMarkdown(rawBody);
      } else if (contentType.includes("application/json")) {
        try {
          markdown = "```json\n" + JSON.stringify(JSON.parse(rawBody), null, 2) + "\n```";
        } catch {
          markdown = rawBody;
        }
      } else {
        markdown = rawBody;
      }

      // Cache the result (respects MAX_CACHE_ENTRIES, evicts oldest by timestamp)
      setCacheEntry(fetchUrl, markdown);
    }

    if (!markdown.trim()) {
      return { output: "The page returned no content.", isError: false };
    }

    // ── Summarize through sonnet ───────────────────────────────
    const summary = await summarizeContent(fetchUrl, markdown, prompt, signal);
    return { output: cap(summary), isError: false };
  } catch (err) {
    // Abort: return a clean non-error message instead of a scary stack trace
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
  display: {
    label: "Browse",
    color: "#50c8c8",  // teal
  },
  summarize,
  execute: executeBrowse,
};
