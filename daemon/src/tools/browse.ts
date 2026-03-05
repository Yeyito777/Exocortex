/**
 * Browse tool — fetch and read web pages.
 *
 * Fetches a URL, converts HTML to markdown, caches results for
 * 15 minutes. Returns raw content for the main model to interpret.
 * Handles HTML, JSON, and plain text content types.
 */

import type { Tool, ToolResult, ToolSummary } from "./types";
import { cap } from "./util";
import { log } from "../log";

// ── Constants ──────────────────────────────────────────────────────

const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

// ── Cache ──────────────────────────────────────────────────────────

const fetchCache = new Map<string, { content: string; ts: number }>();

function cleanCache(): void {
  const now = Date.now();
  for (const [key, entry] of fetchCache) {
    if (now - entry.ts > CACHE_TTL) fetchCache.delete(key);
  }
}

// ── HTML → Markdown ────────────────────────────────────────────────

function htmlToMarkdown(html: string): string {
  let text = html;

  // Remove script, style, and head sections
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<head[\s\S]*?<\/head>/gi, "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  // Block elements → newlines
  text = text.replace(/<\/?(div|p|section|article|aside|header|footer|main|nav|figure|figcaption|details|summary)[^>]*>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<hr\s*\/?>/gi, "\n---\n");

  // Headings
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n");
  text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n");
  text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n");

  // Bold / Italic / Code
  text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

  // Pre/code blocks
  text = text.replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, "\n```\n$1\n```\n");
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n");

  // Blockquotes
  text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner) => {
    return inner.trim().split("\n").map((l: string) => `> ${l}`).join("\n") + "\n";
  });

  // Links
  text = text.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");

  // Images
  text = text.replace(/<img[^>]+alt="([^"]*)"[^>]+src="([^"]*)"[^>]*>/gi, "![$1]($2)");
  text = text.replace(/<img[^>]+src="([^"]*)"[^>]*>/gi, "![]($1)");

  // Lists
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");
  text = text.replace(/<\/?(ul|ol|menu)[^>]*>/gi, "\n");

  // Tables — strip to plain text instead of markdown table syntax.
  // Most tables on the web are layout tables, not data tables.
  text = text.replace(/<\/?(table|thead|tbody|tfoot|caption|colgroup|col)[^>]*>/gi, "\n");
  text = text.replace(/<tr[^>]*>/gi, "\n");
  text = text.replace(/<\/tr>/gi, "");
  text = text.replace(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi, " $1 ");

  // Remove remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)));
  text = text.replace(/&[a-z]+;/gi, "");

  // ── Post-processing cleanup ──────────────────────────────────
  // Strip lines that are only pipes, whitespace, or orphaned markdown
  text = text.replace(/^[ \t]*\|[ \t|]*$/gm, "");
  text = text.replace(/^[ \t]*\*{1,2}[ \t]*$/gm, "");
  // Strip trailing whitespace per line
  text = text.replace(/[ \t]+$/gm, "");
  // Collapse 3+ blank lines to 1
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

// ── Execution ──────────────────────────────────────────────────────

async function executeBrowse(input: Record<string, unknown>): Promise<ToolResult> {
  const url = input.url as string;
  const prompt = input.prompt as string;

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
        } catch {}
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

      // Cache the result
      fetchCache.set(fetchUrl, { content: markdown, ts: Date.now() });
    }

    if (!markdown.trim()) {
      return { output: "The page returned no content.", isError: false };
    }

    // Prepend the prompt context if provided
    const header = prompt
      ? `Content from ${fetchUrl} (looking for: ${prompt}):\n\n`
      : `Content from ${fetchUrl}:\n\n`;

    return { output: cap(header + markdown), isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `browse: ${msg}`);
    return { output: `Error browsing ${fetchUrl}: ${msg}`, isError: true };
  }
}

// ── Summary ────────────────────────────────────────────────────────

function summarize(input: Record<string, unknown>): ToolSummary {
  const url = (input.url as string) ?? "";
  return { label: "Browse", detail: url };
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
