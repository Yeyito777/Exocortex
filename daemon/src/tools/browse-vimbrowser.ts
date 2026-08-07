/**
 * Browser-backed fetch fallback for pages that reject browse's plain HTTP fetch.
 *
 * This deliberately uses the user's running vimbrowser normal profile rather
 * than copying cookies into another HTTP client. One dedicated inactive tab is
 * reused, navigated with location.replace(), read after rendering, and reset to
 * about:blank. If vimbrowser or vimbrowser-cli is unavailable, callers receive
 * null and can preserve the original HTTP error.
 */

import { execFile } from "node:child_process";
import { worktreeName } from "@exocortex/shared/paths";

const VIMBROWSER_IDLE_URL = "about:blank";
const VIMBROWSER_TAB_TITLE = `Exocortex Browse Tool (${worktreeName() ?? "main"})`;
const VIMBROWSER_NAVIGATION_TIMEOUT_MS = 20_000;
const VIMBROWSER_COMMAND_MAX_BUFFER = 32 * 1024 * 1024;
const VIMBROWSER_SETTLE_MS = 750;
const VIMBROWSER_POLL_MS = 200;

export interface VimbrowserFetchedPage {
  html: string;
  pageUrl: string;
}

interface VimbrowserTab {
  id?: unknown;
  context?: unknown;
  loading?: unknown;
  title?: unknown;
  url?: unknown;
}

interface RunVimbrowserOptions {
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type RunVimbrowser = (
  args: string[],
  options?: RunVimbrowserOptions,
) => Promise<string>;

export interface VimbrowserPageFetcherOptions {
  run?: RunVimbrowser;
  navigationTimeoutMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export type VimbrowserPageFetcher = (
  url: string,
  signal?: AbortSignal,
) => Promise<VimbrowserFetchedPage | null>;

class VimbrowserUnavailableError extends Error {}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(typeof reason === "string" ? reason : "Aborted", "AbortError");
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      reject(abortError(signal));
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function defaultRunVimbrowser(
  args: string[],
  options: RunVimbrowserOptions = {},
): Promise<string> {
  const executable = process.env.EXOCORTEX_VIMBROWSER_CLI?.trim() || "vimbrowser-cli";
  return new Promise((resolve, reject) => {
    const child = execFile(executable, args, {
      encoding: "utf8",
      maxBuffer: VIMBROWSER_COMMAND_MAX_BUFFER,
      signal: options.signal,
      timeout: options.timeoutMs ?? 10_000,
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || error.message).trim();
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          reject(new VimbrowserUnavailableError(`${executable} was not found`));
          return;
        }
        reject(new Error(detail || `vimbrowser-cli ${args.join(" ")} failed`));
        return;
      }
      resolve(String(stdout));
    });

    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

function parseObject(raw: string, command: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`vimbrowser-cli returned invalid JSON for ${command}: ${errorMessage(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`vimbrowser-cli returned a non-object response for ${command}`);
  }
  return parsed as Record<string, unknown>;
}

async function runJson(
  run: RunVimbrowser,
  args: string[],
  options?: RunVimbrowserOptions,
): Promise<Record<string, unknown>> {
  return parseObject(await run(args, options), args.join(" "));
}

function tabsFromPayload(payload: Record<string, unknown>): VimbrowserTab[] {
  if (!Array.isArray(payload.tabs)) {
    throw new Error("vimbrowser tabs response did not contain a tabs list");
  }
  return payload.tabs.filter((tab): tab is VimbrowserTab => Boolean(tab) && typeof tab === "object");
}

function tabById(payload: Record<string, unknown>, tabId: number): VimbrowserTab | null {
  return tabsFromPayload(payload).find(tab => tab.id === tabId) ?? null;
}

function isNormalProfileTab(tab: VimbrowserTab): boolean {
  return tab.context === null || tab.context === undefined || tab.context === "";
}

function isRecoverableToolTab(tab: VimbrowserTab): boolean {
  return isNormalProfileTab(tab)
    && tab.url === VIMBROWSER_IDLE_URL
    && tab.title === VIMBROWSER_TAB_TITLE;
}

function challengePage(title: string, html: string): boolean {
  if (/^(?:just a moment|please wait|establishing a secure connection)/i.test(title.trim())) {
    return true;
  }
  return [
    /you(?:'|’)ve been blocked by network security/i,
    /403\s*-\s*forbidden:\s*access is denied/i,
    /cf-chl-/i,
    /bunny[_-]shield/i,
    /checking (?:if the site connection is secure|your browser)/i,
  ].some(pattern => pattern.test(html));
}

function navigationErrorPage(url: string): boolean {
  return /^(?:chrome-error|data):/i.test(url);
}

function navigationScript(url: string): string {
  return `location.replace(${JSON.stringify(url)}); true`;
}

function labelScript(): string {
  return `document.title=${JSON.stringify(VIMBROWSER_TAB_TITLE)}; true`;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function serialize<T>(tail: { current: Promise<void> }, task: () => Promise<T>): Promise<T> {
  const previous = tail.current;
  let release!: () => void;
  tail.current = new Promise<void>(resolve => {
    release = resolve;
  });
  return previous.then(task).finally(release);
}

/** Build a fetcher; exported so tests can exercise the IPC lifecycle without a real browser. */
export function createVimbrowserPageFetcher(
  options: VimbrowserPageFetcherOptions = {},
): VimbrowserPageFetcher {
  const run = options.run ?? defaultRunVimbrowser;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const navigationTimeoutMs = options.navigationTimeoutMs ?? VIMBROWSER_NAVIGATION_TIMEOUT_MS;
  const queue = { current: Promise.resolve() };
  let ownedTabId: number | null = null;

  async function tabs(signal?: AbortSignal, timeoutMs = 5_000): Promise<Record<string, unknown>> {
    return runJson(run, ["tabs", "--json"], { signal, timeoutMs });
  }

  async function labelTab(tabId: number, signal?: AbortSignal): Promise<void> {
    const result = await runJson(run, ["js", String(tabId)], {
      input: labelScript(),
      signal,
      timeoutMs: 5_000,
    });
    if (!result.ok) throw new Error("vimbrowser could not label the background browse tab");
  }

  async function navigate(tabId: number, url: string, signal?: AbortSignal): Promise<void> {
    const result = await runJson(run, ["js", String(tabId)], {
      input: navigationScript(url),
      signal,
      timeoutMs: 10_000,
    });
    if (!result.ok) throw new Error("vimbrowser rejected background-tab navigation");
  }

  async function ensureTab(signal?: AbortSignal): Promise<number> {
    const payload = await tabs(signal, 2_000);
    if (ownedTabId !== null) {
      const owned = tabById(payload, ownedTabId);
      if (owned && isNormalProfileTab(owned)) return ownedTabId;
      ownedTabId = null;
    }

    const recovered = tabsFromPayload(payload).find(isRecoverableToolTab);
    const recoveredId = recovered ? positiveInteger(recovered.id) : null;
    if (recoveredId !== null) {
      ownedTabId = recoveredId;
      return recoveredId;
    }

    const activeBefore = positiveInteger(payload.active_tabid);
    const created = await runJson(run, ["open", VIMBROWSER_IDLE_URL], {
      signal,
      timeoutMs: 10_000,
    });
    const createdId = positiveInteger(created.active_tabid);
    if (createdId === null) throw new Error("vimbrowser did not report the new browse tab ID");

    if (activeBefore !== null && activeBefore !== createdId) {
      await run(["focus", String(activeBefore)], {
        signal,
        timeoutMs: 5_000,
      });
    }
    await labelTab(createdId, signal);
    ownedTabId = createdId;
    return createdId;
  }

  async function waitForPage(
    tabId: number,
    requestedUrl: string,
    signal?: AbortSignal,
  ): Promise<VimbrowserFetchedPage> {
    const deadline = now() + navigationTimeoutMs;
    let settledAt: number | null = null;
    let lastHtmlAt = 0;
    let lastUrl = "";
    let sawChallenge = false;

    while (now() < deadline) {
      if (signal?.aborted) throw abortError(signal);
      const payload = await tabs(signal);
      const tab = tabById(payload, tabId);
      if (!tab) throw new Error("the background browse tab was closed");

      lastUrl = typeof tab.url === "string" ? tab.url : "";
      const title = typeof tab.title === "string" ? tab.title : "";
      const loading = Boolean(tab.loading);
      const leftIdlePage = lastUrl !== "" && lastUrl !== VIMBROWSER_IDLE_URL;

      if (leftIdlePage && !loading) {
        settledAt ??= now();
        if (now() - settledAt >= VIMBROWSER_SETTLE_MS && now() - lastHtmlAt >= VIMBROWSER_SETTLE_MS) {
          lastHtmlAt = now();
          const html = await run(["html", String(tabId)], { signal, timeoutMs: 20_000 });
          if (navigationErrorPage(lastUrl)) {
            throw new Error(`vimbrowser could not load ${requestedUrl} (${lastUrl})`);
          }
          if (!challengePage(title, html) && html.trim()) {
            return { html, pageUrl: lastUrl };
          }
          sawChallenge = true;
        }
      } else {
        settledAt = null;
      }

      await sleep(VIMBROWSER_POLL_MS, signal);
    }

    if (sawChallenge) {
      throw new Error(`vimbrowser remained on an access challenge for ${requestedUrl}`);
    }
    throw new Error(
      `vimbrowser did not finish loading ${requestedUrl} within ${Math.round(navigationTimeoutMs / 1_000)}s`
      + (lastUrl ? ` (last URL: ${lastUrl})` : ""),
    );
  }

  async function resetTab(tabId: number): Promise<void> {
    await navigate(tabId, VIMBROWSER_IDLE_URL);
    const deadline = now() + 3_000;
    while (now() < deadline) {
      const payload = await tabs(undefined, 3_000);
      const tab = tabById(payload, tabId);
      if (!tab) {
        ownedTabId = null;
        return;
      }
      if (tab.url === VIMBROWSER_IDLE_URL && !tab.loading) {
        await labelTab(tabId);
        return;
      }
      await sleep(100);
    }
    throw new Error("timed out resetting the background browse tab");
  }

  return async (url: string, signal?: AbortSignal): Promise<VimbrowserFetchedPage | null> => {
    return serialize(queue, async () => {
      if (signal?.aborted) throw abortError(signal);
      let tabId: number;
      try {
        tabId = await ensureTab(signal);
      } catch (error) {
        if (error instanceof VimbrowserUnavailableError) return null;
        const message = errorMessage(error);
        if (/not found|no vimbrowser IPC socket|connection refused|timed out connecting/i.test(message)) {
          return null;
        }
        throw error;
      }

      try {
        await navigate(tabId, url, signal);
        return await waitForPage(tabId, url, signal);
      } finally {
        try {
          // Reset even when the caller's signal was aborted; leaving arbitrary web
          // content in the dedicated tab would make a later fallback unpredictable.
          await resetTab(tabId);
        } catch {
          ownedTabId = null;
        }
      }
    });
  };
}

export const fetchPageWithVimbrowser = createVimbrowserPageFetcher();

export const browseVimbrowserInternalsForTest = {
  challengePage,
  navigationScript,
  tabTitle: VIMBROWSER_TAB_TITLE,
};
