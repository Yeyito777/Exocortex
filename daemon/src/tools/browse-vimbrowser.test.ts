import { describe, expect, test } from "bun:test";
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
});
