const CLOUDFLARE_COOKIE_NAMES = new Set([
  "__cf_bm",
  "__cflb",
  "__cfruid",
  "__cfseq",
  "__cfwaitingroom",
  "_cfuvid",
  "cf_clearance",
  "cf_ob_info",
  "cf_use_ob",
]);

const cloudflareCookies = new Map<string, string>();

function isCloudflareCookieName(name: string): boolean {
  return CLOUDFLARE_COOKIE_NAMES.has(name) || name.startsWith("cf_chl_");
}

function isChatGPTHost(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    if (protocol !== "https:") return false;
    return hostname === "chatgpt.com"
      || hostname.endsWith(".chatgpt.com")
      || hostname === "chat.openai.com"
      || hostname.endsWith(".chat.openai.com");
  } catch {
    return false;
  }
}

function splitSetCookieHeader(value: string): string[] {
  return value.split(/,(?=\s*[A-Za-z0-9_]+=)/).map((part) => part.trim()).filter(Boolean);
}

function getSetCookieValues(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  const values = withGetSetCookie.getSetCookie?.();
  if (values && values.length > 0) return values;

  const fallback = headers.get("set-cookie");
  return fallback ? splitSetCookieHeader(fallback) : [];
}

export function buildCloudflareCookieHeader(url: string): string | null {
  if (!isChatGPTHost(url) || cloudflareCookies.size === 0) return null;
  return [...cloudflareCookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

export function storeCloudflareCookiesFromHeaders(url: string, headers: Headers): void {
  if (!isChatGPTHost(url)) return;

  for (const cookie of getSetCookieValues(headers)) {
    const pair = cookie.split(";", 1)[0]?.trim();
    if (!pair) continue;

    const separator = pair.indexOf("=");
    if (separator <= 0) continue;

    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (isCloudflareCookieName(name)) {
      cloudflareCookies.set(name, value);
    }
  }
}

export function clearCloudflareCookiesForTest(): void {
  cloudflareCookies.clear();
}
