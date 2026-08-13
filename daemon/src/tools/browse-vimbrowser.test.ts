import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browseVimbrowserInternalsForTest,
  createVimbrowserPageFetcher,
  type RunVimbrowser,
} from "./browse-vimbrowser";

describe("browse vimbrowser backend", () => {
  test("owns an inactive tab, renders a page, and resets it", async () => {
    let now = 0;
    let activeTabId = 3;
    let toolTabId: number | null = null;
    let toolUrl = "";
    let toolTitle = "";
    const calls: Array<{ args: string[]; input?: string }> = [];

    const run: RunVimbrowser = async (args, options = {}) => {
      calls.push({ args, input: options.input });
      const command = args[0];
      if (command === "tabs") {
        const tabs: Array<Record<string, unknown>> = [
          { id: 3, context: null, loading: false, title: "User tab", url: "https://user.example/" },
        ];
        if (toolTabId !== null) {
          tabs.push({
            id: toolTabId,
            context: null,
            loading: false,
            title: toolTitle,
            url: toolUrl,
          });
        }
        return JSON.stringify({ active_tabid: activeTabId, tabs });
      }
      if (command === "open") {
        toolTabId = 8;
        activeTabId = 8;
        toolUrl = "about:blank";
        return JSON.stringify({ active_tabid: 8 });
      }
      if (command === "focus") {
        activeTabId = Number(args[1]);
        return JSON.stringify({ ok: true });
      }
      if (command === "js") {
        if (options.input?.startsWith("location.replace")) {
          const encodedUrl = options.input.slice("location.replace(".length, options.input.indexOf("); true"));
          toolUrl = JSON.parse(encodedUrl);
          toolTitle = toolUrl === "about:blank" ? "" : "Rendered page";
        } else if (options.input?.startsWith("document.title=")) {
          const encodedTitle = options.input.slice("document.title=".length, options.input.indexOf("; true"));
          toolTitle = JSON.parse(encodedTitle);
        }
        return JSON.stringify({ ok: true });
      }
      if (command === "html") {
        return "<!doctype html><html><head><title>Rendered page</title></head><body><main>Browser content</main></body></html>";
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    };

    const fetcher = createVimbrowserPageFetcher({
      run,
      now: () => now,
      sleep: async milliseconds => {
        now += milliseconds;
      },
    });
    const result = await fetcher("https://blocked.example/page");

    expect(result?.pageUrl).toBe("https://blocked.example/page");
    expect(result?.html).toContain("Browser content");
    expect(activeTabId).toBe(3);
    expect(toolUrl).toBe("about:blank");
    expect(toolTitle).toBe(browseVimbrowserInternalsForTest.tabTitle);
    expect(calls.some(call => call.args[0] === "html")).toBe(true);
    expect(calls.filter(call => call.args[0] === "focus")).toHaveLength(1);
  });

  test("recognizes common rendered challenge pages", () => {
    const { challengePage } = browseVimbrowserInternalsForTest;
    expect(challengePage("Just a moment...", "<html></html>")).toBe(true);
    expect(challengePage("", "You've been blocked by network security.")).toBe(true);
    expect(challengePage("", "<h1>Verifying you are human.</h1><p>The server reviews the security of your connection.</p>")).toBe(true);
    expect(challengePage("", 'document.cookie="artsci_chal=" + answer; document.location.reload(true)')).toBe(true);
    expect(challengePage("Documentation", "<main>Useful content</main>")).toBe(false);
  });

  test("returns null when vimbrowser is not installed", async () => {
    const fetcher = createVimbrowserPageFetcher({
      run: async () => {
        const error = Object.assign(new Error("vimbrowser-cli was not found"), { code: "ENOENT" });
        throw error;
      },
    });
    await expect(fetcher("https://blocked.example/page")).resolves.toBeNull();
  });

  test("streams an exact same-profile response to the requested workspace", async () => {
    let now = 0;
    let activeTabId = 3;
    let toolTabId: number | null = null;
    let toolUrl = "";
    let toolTitle = "";
    let status = "missing";
    let offset = 0;
    let pending = Buffer.alloc(0);
    const bytes = Buffer.alloc(800_000);
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
    const calls: Array<{ args: string[]; input?: string }> = [];
    const markers = browseVimbrowserInternalsForTest.downloadScriptMarkers;
    const scriptResult = (value: Record<string, unknown>) => JSON.stringify({
      ok: true,
      type: "string",
      result: JSON.stringify(value),
    });

    const run: RunVimbrowser = async (args, options = {}) => {
      calls.push({ args, input: options.input });
      const command = args[0];
      if (command === "tabs") {
        const tabs: Array<Record<string, unknown>> = [
          { id: 3, context: null, loading: false, title: "User tab", url: "https://user.example/" },
        ];
        if (toolTabId !== null) {
          tabs.push({ id: toolTabId, context: null, loading: false, title: toolTitle, url: toolUrl });
        }
        return JSON.stringify({ active_tabid: activeTabId, tabs });
      }
      if (command === "open") {
        toolTabId = 8;
        activeTabId = 8;
        toolUrl = "about:blank";
        return JSON.stringify({ active_tabid: 8 });
      }
      if (command === "focus") {
        activeTabId = Number(args[1]);
        return JSON.stringify({ ok: true });
      }
      if (command === "js") {
        const script = options.input ?? "";
        if (script.startsWith(markers.start)) {
          status = "ready";
          return scriptResult({ started: true });
        }
        if (script.startsWith(markers.status)) {
          return scriptResult({
            status,
            error: "",
            pageUrl: toolUrl,
            contentType: "application/javascript; charset=utf-8",
            contentDisposition: 'attachment; filename="browser-asset.js"',
            declaredBytes: bytes.length,
            totalBytes: offset,
          });
        }
        if (script.startsWith(markers.next)) {
          if (offset >= bytes.length) {
            status = "done";
            return scriptResult({ started: false, status: "done" });
          }
          pending = bytes.subarray(offset, Math.min(offset + 300_000, bytes.length));
          offset += pending.length;
          status = "chunk";
          return scriptResult({ started: true });
        }
        if (script.startsWith(markers.take)) {
          const chunk = pending;
          pending = Buffer.alloc(0);
          status = offset >= bytes.length ? "done" : "ready";
          return scriptResult({ bytes: chunk.length, base64: chunk.toString("base64") });
        }
        if (script.startsWith(markers.cleanup)) {
          status = "missing";
          return scriptResult({ cleaned: true });
        }
        if (script.startsWith("location.replace")) {
          const encodedUrl = script.slice("location.replace(".length, script.indexOf("); true"));
          toolUrl = JSON.parse(encodedUrl);
          toolTitle = toolUrl === "about:blank" ? "" : "JavaScript asset";
        } else if (script.startsWith("document.title=")) {
          const encodedTitle = script.slice("document.title=".length, script.indexOf("; true"));
          toolTitle = JSON.parse(encodedTitle);
        }
        return JSON.stringify({ ok: true });
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    };

    const fetcher = createVimbrowserPageFetcher({
      run,
      now: () => now,
      sleep: async milliseconds => {
        now += milliseconds;
      },
    });
    const root = mkdtempSync(join(tmpdir(), "exocortex-vimbrowser-download-"));
    try {
      const result = await fetcher.download!("https://blocked.example/browser-asset.js", root);
      expect(result).not.toBeNull();
      expect(result && "redirectUrl" in result).toBe(false);
      if (!result || "redirectUrl" in result) throw new Error("expected a downloaded file");
      expect(readFileSync(join(root, "browser-asset.js"))).toEqual(bytes);
      expect(result.bytes).toBe(bytes.length);
      expect(result.contentType).toBe("application/javascript");
      expect(result.sha256).toHaveLength(64);
      expect(activeTabId).toBe(3);
      expect(toolUrl).toBe("about:blank");
      expect(calls.some(call => call.args[0] === "html")).toBe(false);
      expect(calls.filter(call => call.input?.startsWith(markers.take))).toHaveLength(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
