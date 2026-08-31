/**
 * SSH-aware prompt path completion.
 *
 * Remote directory listings are cached by SSH alias and prompt-spelled path.
 * Fresh entries complete synchronously; stale entries complete optimistically
 * while refreshing in the background. Typing prefetches the current directory,
 * and daemon-supplied child listings remove the next round trip in most trees.
 */

import type { CompletionItem } from "./commands";
import type { ErrorEvent, PathDirectoryEntriesEvent, PathDirectoryListing } from "./protocol";
import type { RenderState } from "./state";
import {
  extractPathToken,
  filesystemMatchesFromEntries,
  pathTokenParts,
  type PathCompletionProvider,
} from "./autocomplete";

const FRESH_CACHE_MS = 15_000;
const STALE_CACHE_MS = 5 * 60_000;
const INFLIGHT_EXPIRY_MS = 8_000;
const MAX_CACHED_LISTINGS_PER_ROUTE = 192;

interface CachedListing {
  listing: PathDirectoryListing;
  receivedAt: number;
  usedAt: number;
}

interface InflightListing {
  reqId: string;
  route: string;
  directory: string;
  prefix: string;
  requestedAt: number;
}

interface CompletionIntent {
  route: string;
  pathToken: string;
  onReady: () => void;
}

export interface PathCompletionEventResult {
  consumed: boolean;
  uiChanged: boolean;
}

export type RequestPathDirectory = (
  directory: string,
  prefix: string,
) => string | null;

function listingKey(directory: string, prefix: string): string {
  return `${directory}\0${prefix}`;
}

export class RemotePathCompletionController implements PathCompletionProvider {
  private remoteAlias: string | null = null;
  private readonly cacheByRoute = new Map<string, Map<string, CachedListing>>();
  private readonly inflightByReqId = new Map<string, InflightListing>();
  private completionIntent: CompletionIntent | null = null;

  constructor(
    private readonly requestPathDirectory: RequestPathDirectory,
    private readonly now: () => number = Date.now,
  ) {}

  /** Retains per-alias caches so returning to a route rehydrates instantly. */
  setRemoteAlias(alias: string | null): void {
    if (alias === this.remoteAlias) return;
    this.remoteAlias = alias;
    this.completionIntent = null;
  }

  getFilesystemMatches(pathToken: string): CompletionItem[] | null {
    if (pathToken === "~") return [{ name: "~/", desc: "dir" }];
    const route = this.remoteAlias;
    if (!route) return null;
    const cached = this.findCachedListing(route, pathToken);
    if (!cached) return null;

    const age = this.now() - cached.receivedAt;
    cached.usedAt = this.now();
    if (age > FRESH_CACHE_MS) {
      // Stale-while-revalidate: keep Tab immediate while updating the route's
      // view in the background. Results never cross alias cache partitions.
      this.requestToken(route, pathToken);
    }
    return filesystemMatchesFromEntries(pathToken, cached.listing.entries);
  }

  requestFilesystemMatches(pathToken: string, onReady?: () => void): void {
    const route = this.remoteAlias;
    if (!route) return;
    if (onReady) this.completionIntent = { route, pathToken, onReady };

    if (pathToken === "~") {
      if (onReady) queueMicrotask(() => this.finishReadyIntent(route));
      return;
    }
    this.requestToken(route, pathToken);
  }

  /**
   * Called after prompt edits. It fetches before Tab and follows a unique
   * directory candidate, which overlaps SSH latency with normal typing.
   */
  observePrompt(state: RenderState): void {
    const route = this.remoteAlias;
    if (!route || state.panelFocus !== "chat" || state.chatFocus !== "prompt") return;
    const extracted = extractPathToken(state.inputBuffer, state.cursorPos);
    if (!extracted) return;

    const matches = this.getFilesystemMatches(extracted.token);
    if (matches === null) {
      this.requestToken(route, extracted.token);
      return;
    }

    const directoryMatches = matches.filter(match => match.desc === "dir");
    if (directoryMatches.length === 1) {
      // The unique candidate is the overwhelmingly likely next path segment.
      this.requestToken(route, directoryMatches[0]!.name);
    }
  }

  handleEvent(
    event: PathDirectoryEntriesEvent | ErrorEvent,
    state?: RenderState,
  ): PathCompletionEventResult {
    if (!event.reqId) return { consumed: false, uiChanged: false };
    const request = this.inflightByReqId.get(event.reqId);
    if (!request) return { consumed: false, uiChanged: false };
    this.inflightByReqId.delete(event.reqId);

    if (event.type === "path_directory_entries") {
      for (const listing of event.listings) this.storeListing(request.route, listing);
    } else {
      // Old daemons answer the new command with a correlated Unknown command
      // error. Treat that as an empty remote result; never fall back to host fs.
      this.storeListing(request.route, {
        directory: request.directory,
        prefix: request.prefix,
        entries: [],
      });
    }

    const beforeBuffer = state?.inputBuffer;
    const beforeCursor = state?.cursorPos;
    const beforeAutocomplete = state?.autocomplete;
    this.finishReadyIntent(request.route);
    if (state) this.observePrompt(state);
    return {
      consumed: true,
      uiChanged: !!state && (
        state.inputBuffer !== beforeBuffer
        || state.cursorPos !== beforeCursor
        || state.autocomplete !== beforeAutocomplete
      ),
    };
  }

  private finishReadyIntent(route: string): void {
    const intent = this.completionIntent;
    if (!intent || intent.route !== route || this.remoteAlias !== route) return;
    if (intent.pathToken !== "~" && !this.findCachedListing(route, intent.pathToken)) return;
    this.completionIntent = null;
    intent.onReady();
  }

  private requestToken(route: string, pathToken: string): void {
    const parts = pathTokenParts(pathToken);
    if (!parts) return;
    this.expireInflight();

    // Once the user types the first basename character, allow one targeted
    // request alongside an earlier empty-prefix prefetch. The targeted response
    // carries lookahead for the likely child; later characters reuse that same
    // request instead of generating one request per keystroke.
    const covered = [...this.inflightByReqId.values()].some(request => (
      request.route === route
      && request.directory === parts.directory
      && parts.prefix.startsWith(request.prefix)
      && (request.prefix.length > 0 || parts.prefix.length === 0)
    ));
    if (covered) return;

    const reqId = this.requestPathDirectory(parts.directory, parts.prefix);
    if (!reqId) return;
    this.inflightByReqId.set(reqId, {
      reqId,
      route,
      directory: parts.directory,
      prefix: parts.prefix,
      requestedAt: this.now(),
    });
  }

  private findCachedListing(route: string, pathToken: string): CachedListing | null {
    const parts = pathTokenParts(pathToken);
    if (!parts) return null;
    const routeCache = this.cacheByRoute.get(route);
    if (!routeCache) return null;

    let best: CachedListing | null = null;
    for (const [key, cached] of routeCache) {
      if (this.now() - cached.receivedAt > STALE_CACHE_MS) {
        routeCache.delete(key);
        continue;
      }
      const listing = cached.listing;
      if (listing.directory !== parts.directory || !parts.prefix.startsWith(listing.prefix)) continue;
      // A truncated broad query cannot prove it includes every narrower match.
      // Its exact-prefix subset is still useful as a bounded optimistic result.
      if (listing.truncated && listing.prefix !== parts.prefix) continue;
      if (!best || listing.prefix.length > best.listing.prefix.length) best = cached;
    }
    return best;
  }

  private storeListing(route: string, listing: PathDirectoryListing): void {
    let routeCache = this.cacheByRoute.get(route);
    if (!routeCache) {
      routeCache = new Map();
      this.cacheByRoute.set(route, routeCache);
    }
    const timestamp = this.now();
    routeCache.set(listingKey(listing.directory, listing.prefix), {
      listing,
      receivedAt: timestamp,
      usedAt: timestamp,
    });

    if (routeCache.size <= MAX_CACHED_LISTINGS_PER_ROUTE) return;
    const oldest = [...routeCache.entries()]
      .sort((a, b) => a[1].usedAt - b[1].usedAt)
      .slice(0, routeCache.size - MAX_CACHED_LISTINGS_PER_ROUTE);
    for (const [key] of oldest) routeCache.delete(key);
  }

  private expireInflight(): void {
    const expiredBefore = this.now() - INFLIGHT_EXPIRY_MS;
    for (const [reqId, request] of this.inflightByReqId) {
      if (request.requestedAt < expiredBefore) this.inflightByReqId.delete(reqId);
    }
  }
}

