/**
 * HTML → Markdown converter.
 *
 * Regex-based, no dependencies. Strips scripts, styles, nav chrome,
 * and decodes common entities. Good enough for feeding web content
 * into an LLM — not aiming for perfect markdown fidelity.
 */

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    .replace(/&[a-z]+;/gi, "");
}

function normalizeUrl(url: string, baseUrl?: string): string {
  const decoded = decodeHtmlEntities(url.trim());
  if (!decoded) return decoded;
  if (!baseUrl) return decoded;
  try {
    return new URL(decoded, baseUrl).toString();
  } catch {
    return decoded;
  }
}

export function htmlToMarkdown(html: string, baseUrl?: string): string {
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
  text = text.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
    return `[${label}](${normalizeUrl(href, baseUrl)})`;
  });

  // Images
  text = text.replace(/<img[^>]+alt="([^"]*)"[^>]+src="([^"]*)"[^>]*>/gi, (_, alt, src) => {
    return `![${alt}](${normalizeUrl(src, baseUrl)})`;
  });
  text = text.replace(/<img[^>]+src="([^"]*)"[^>]*>/gi, (_, src) => {
    return `![](${normalizeUrl(src, baseUrl)})`;
  });

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
  text = decodeHtmlEntities(text);

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
