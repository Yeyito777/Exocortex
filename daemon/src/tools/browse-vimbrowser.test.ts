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
  test.each([3, 4])("owns only the new background tab when the active tab becomes %i", async activeAfterOpen => {
    let now = 0;
    let activeTabId = 3;
    let toolTabId: number | null = null;
    let toolUrl = "";
    let toolTitle = "";
    const calls: Array<{ args: string[]; input?: string }> = [];

    const tabsPayload = () => {
      const tabs: Array<Record<string, unknown>> = [
        { id: 3, context: null, loading: false, title: "User tab", url: "https://user.example/" },
        { id: 4, context: null, loading: false, title: "Other user tab", url: "https://other.example/" },
        { id: 6, context: null, loading: false, title: "", url: "about:blank" },
      ];
      if (toolTabId !== null) {
        // Ownership must not depend on tab-stack position or a preexisting blank.
        tabs.unshift({
          id: toolTabId,
          context: null,
          loading: false,
          title: toolTitle,
          url: toolUrl,
        });
      }
      return JSON.stringify({ active_tabid: activeTabId, visible_tabid: activeTabId, tabs });
    };

    const run: RunVimbrowser = async (args, options = {}) => {
      calls.push({ args, input: options.input });
      const command = args[0];
      if (command === "tabs") {
        return tabsPayload();
      }
      if (command === "open") {
        toolTabId = 8;
        // Background open does not focus the new tab. The user may independently
        // change focus while the open command is in flight.
        activeTabId = activeAfterOpen;
        toolUrl = "about:blank";
        return tabsPayload();
      }
      if (command === "js") {
        expect(args[1]).toBe(String(toolTabId));
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
        expect(args[1]).toBe(String(toolTabId));
        return "<!doctype html><html><head><title>Rendered page</title></head><body><main>Browser content</main></body></html>";
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    };

    const options = {
      run,
      now: () => now,
      sleep: async (milliseconds: number) => {
        now += milliseconds;
      },
    };
    const fetcher = createVimbrowserPageFetcher(options);
    const result = await fetcher("https://blocked.example/page");

    expect(result?.pageUrl).toBe("https://blocked.example/page");
    expect(result?.html).toContain("Browser content");
    expect(activeTabId).toBe(activeAfterOpen);
    expect(toolUrl).toBe("about:blank");
    expect(toolTitle).toBe(browseVimbrowserInternalsForTest.tabTitle);
    expect(calls.some(call => call.args[0] === "html")).toBe(true);
    // Reuse the owned tab, and recover it in a fresh fetcher, without opening
    // additional tabs or touching either user tab.
    await fetcher("https://blocked.example/second");
    await createVimbrowserPageFetcher(options)("https://blocked.example/recovered");
    expect(toolUrl).toBe("about:blank");
    expect(toolTitle).toBe(browseVimbrowserInternalsForTest.tabTitle);
    expect(activeTabId).toBe(activeAfterOpen);
    expect(calls.filter(call => call.args[0] === "open")).toHaveLength(1);
    expect(calls.filter(call => call.args[0] === "focus")).toHaveLength(0);
  });

  const preexistingTabs = [
    { id: 3, context: null, loading: false, title: "User tab", url: "https://user.example/" },
    { id: 6, context: null, loading: false, title: "", url: "about:blank" },
  ];
  const newBlankTab = { id: 8, context: null, loading: false, title: "", url: "about:blank" };
  const unsafeOpenResponses: Array<{ name: string; response: Record<string, unknown> }> = [
    { name: "no new tab", response: { active_tabid: 3, tabs: preexistingTabs } },
    {
      name: "multiple new tabs",
      response: { active_tabid: 3, tabs: [...preexistingTabs, newBlankTab, { ...newBlankTab, id: 9 }] },
    },
    {
      name: "duplicate new IDs",
      response: { active_tabid: 3, tabs: [...preexistingTabs, newBlankTab, newBlankTab] },
    },
    {
      name: "an invalid new ID",
      response: { active_tabid: 3, tabs: [...preexistingTabs, { ...newBlankTab, id: "8" }] },
    },
    {
      name: "a named-context tab",
      response: { active_tabid: 3, tabs: [...preexistingTabs, { ...newBlankTab, context: "private" }] },
    },
    {
      name: "a non-idle tab",
      response: { active_tabid: 3, tabs: [...preexistingTabs, { ...newBlankTab, url: "https://user.example/" }] },
    },
    {
      name: "an active new tab",
      response: { active_tabid: 8, visible_tabid: 3, tabs: [...preexistingTabs, newBlankTab] },
    },
    {
      name: "a visible new tab",
      response: { active_tabid: 3, visible_tabid: 8, tabs: [...preexistingTabs, newBlankTab] },
    },
    { name: "a missing tabs list", response: { active_tabid: 3 } },
  ];
  for (const { name, response } of unsafeOpenResponses) {
    test(`refuses ${name} without mutating any tab`, async () => {
      const calls: string[][] = [];
      const fetcher = createVimbrowserPageFetcher({
        run: async args => {
          calls.push(args);
          if (args[0] === "tabs") return JSON.stringify({ active_tabid: 3, tabs: preexistingTabs });
          if (args[0] === "open") return JSON.stringify(response);
          throw new Error(`unexpected command: ${args.join(" ")}`);
        },
      });
      await expect(fetcher("https://blocked.example/page")).rejects.toThrow("vimbrowser");
      expect(calls.map(args => args[0])).toEqual(["tabs", "open"]);
    });
  }

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
    const activeTabId = 3;
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

    const tabsPayload = () => {
      const tabs: Array<Record<string, unknown>> = [
        { id: 3, context: null, loading: false, title: "User tab", url: "https://user.example/" },
      ];
      if (toolTabId !== null) {
        tabs.push({ id: toolTabId, context: null, loading: false, title: toolTitle, url: toolUrl });
      }
      return JSON.stringify({ active_tabid: activeTabId, visible_tabid: activeTabId, tabs });
    };

    const run: RunVimbrowser = async (args, options = {}) => {
      calls.push({ args, input: options.input });
      const command = args[0];
      if (command === "tabs") {
        return tabsPayload();
      }
      if (command === "open") {
        toolTabId = 8;
        toolUrl = "about:blank";
        return tabsPayload();
      }
      if (command === "js") {
        expect(args[1]).toBe(String(toolTabId));
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
      expect(calls.some(call => call.args[0] === "focus")).toBe(false);
      expect(calls.filter(call => call.input?.startsWith(markers.take))).toHaveLength(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
