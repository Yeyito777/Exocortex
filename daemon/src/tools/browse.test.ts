import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { browseInternalsForTest } from "./browse";

const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "exocortex-browse-download-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("browse source", () => {
  test("uses the current focused digestor Relevant Links prompt", () => {
    const source = readFileSync(join(import.meta.dir, "browse.ts"), "utf8");
    expect(source).toContain("You are a web page digestor");
    expect(source).toContain("Produce a focused, useful digest");
    expect(source).toContain("Prefer concise answers; include detail when the prompt asks for it");
    expect(source).toContain("Max 7 links");
    expect(source).toContain("1. [Title](URL)");
  });

  test("tells the model how to preserve readable responses without AI interpretation", () => {
    const source = readFileSync(join(import.meta.dir, "browse.ts"), "utf8");
    expect(source).toContain("Use mode=download whenever the complete response must be preserved");
    expect(source).toContain("including text, JavaScript, JSON, or source code");
  });

  test("does not import deterministic browse helpers", () => {
    const source = readFileSync(join(import.meta.dir, "browse.ts"), "utf8");
    expect(source).not.toContain('from "./browse/index"');
    expect(source).not.toContain("extractRelevantLinks(");
    expect(source).not.toContain("buildRelevantLinksSection(");
  });
});

describe("browse direct downloads", () => {
  test("forced download saves a textual JavaScript response and bypasses the digest cache", async () => {
    const cwd = workspace();
    const url = "https://cdn.example.test/static/main.forced-download.js";
    const asset = Buffer.from("window.__completeAsset = 'yes';\n", "utf8");
    let fetchCalls = 0;
    let summaryCalls = 0;
    const dependencies = {
      fetch: async () => {
        fetchCalls++;
        return new Response(fetchCalls === 1 ? "cached digest content" : asset, {
          headers: { "content-type": "application/javascript; charset=utf-8" },
        });
      },
      summarize: async () => {
        summaryCalls++;
        return "digest";
      },
    };

    const digested = await browseInternalsForTest.executeBrowse(
      { url, prompt: "summarize it" },
      { cwd },
      undefined,
      dependencies,
    );
    const downloaded = await browseInternalsForTest.executeBrowse(
      { url, mode: "download" },
      { cwd },
      undefined,
      dependencies,
    );

    expect(digested.output).toBe("digest");
    expect(downloaded.isError).toBe(false);
    expect(downloaded.output).toContain(join(cwd, "main.forced-download.js"));
    expect(downloaded.output).toContain(createHash("sha256").update(asset).digest("hex"));
    expect(readFileSync(join(cwd, "main.forced-download.js"))).toEqual(asset);
    expect(fetchCalls).toBe(2);
    expect(summaryCalls).toBe(1);
  });

  test("saves binary CDN responses byte-for-byte without calling the summarizer", async () => {
    const cwd = workspace();
    const bytes = new Uint8Array([0, 255, 1, 128, 42]);
    let summaryCalls = 0;

    const result = await browseInternalsForTest.executeBrowse(
      { url: "https://cdn.example.test/assets/opaque", prompt: "inspect it" },
      { cwd },
      undefined,
      {
        fetch: async () => new Response(bytes, {
          headers: {
            "content-disposition": "attachment; filename*=UTF-8''sample%20image.png",
            "content-type": "image/png",
          },
        }),
        summarize: async () => {
          summaryCalls++;
          return "unexpected summary";
        },
      },
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("Downloaded https://cdn.example.test/assets/opaque");
    expect(result.output).toContain(join(cwd, "sample image.png"));
    expect(summaryCalls).toBe(0);
    expect(new Uint8Array(readFileSync(join(cwd, "sample image.png")))).toEqual(bytes);
  });

  test("honors attachment disposition even when the server labels the file as text", async () => {
    const cwd = workspace();
    let summaryCalls = 0;
    const result = await browseInternalsForTest.executeBrowse(
      { url: "https://files.example.test/notes", prompt: "read notes" },
      { cwd },
      undefined,
      {
        fetch: async () => new Response("do not summarize me", {
          headers: {
            "content-disposition": 'attachment; filename="notes.txt"',
            "content-type": "text/plain; charset=utf-8",
          },
        }),
        summarize: async () => {
          summaryCalls++;
          return "unexpected summary";
        },
      },
    );

    expect(result.isError).toBe(false);
    expect(readFileSync(join(cwd, "notes.txt"), "utf8")).toBe("do not summarize me");
    expect(summaryCalls).toBe(0);
  });

  test("uses binary URL extensions when a CDN omits Content-Type", async () => {
    const cwd = workspace();
    const result = await browseInternalsForTest.executeBrowse(
      { url: "https://cdn.example.test/releases/package.zip?signature=abc", prompt: "get it" },
      { cwd },
      undefined,
      {
        fetch: async () => new Response(new Uint8Array([80, 75, 3, 4])),
        summarize: async () => "unexpected summary",
      },
    );

    expect(result.isError).toBe(false);
    expect(readFileSync(join(cwd, "package.zip"))).toEqual(Buffer.from([80, 75, 3, 4]));
  });

  test("keeps normal web-readable responses on the summarization path", async () => {
    const cwd = workspace();
    let summaryCalls = 0;
    const result = await browseInternalsForTest.executeBrowse(
      { url: "https://www.example.test/page", prompt: "summarize" },
      { cwd },
      undefined,
      {
        fetch: async () => new Response("<main>Hello</main>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
        summarize: async () => {
          summaryCalls++;
          return "web summary";
        },
      },
    );

    expect(result).toEqual({ output: "web summary", isError: false });
    expect(summaryCalls).toBe(1);
    expect(readdirSync(cwd)).toEqual([]);
  });

  test("sanitizes untrusted filenames and avoids overwriting existing downloads", async () => {
    const cwd = workspace();
    const dependencies = {
      fetch: async () => new Response("payload", {
        headers: {
          "content-disposition": 'attachment; filename="../../payload.bin"',
          "content-type": "application/octet-stream",
        },
      }),
      summarize: async () => "unexpected summary",
    };

    const first = await browseInternalsForTest.executeBrowse(
      { url: "https://cdn.example.test/download", prompt: "get it" },
      { cwd },
      undefined,
      dependencies,
    );
    const second = await browseInternalsForTest.executeBrowse(
      { url: "https://cdn.example.test/download", prompt: "get it" },
      { cwd },
      undefined,
      dependencies,
    );

    const downloaded = readdirSync(cwd);
    expect(first.isError).toBe(false);
    expect(second.isError).toBe(false);
    expect(downloaded).toHaveLength(2);
    expect(new Set(downloaded).size).toBe(2);
    expect(downloaded.every(name => basename(name) === name && name.includes("payload") && name.endsWith(".bin"))).toBe(true);
  });

  test("does not create files when downloads are disabled by a read-only context", async () => {
    const cwd = workspace();
    let summaryCalls = 0;
    const result = await browseInternalsForTest.executeBrowse(
      { url: "https://cdn.example.test/file.pdf", prompt: "inspect it" },
      { cwd, allowDownloads: false },
      undefined,
      {
        fetch: async () => new Response("pdf", { headers: { "content-type": "application/pdf" } }),
        summarize: async () => {
          summaryCalls++;
          return "unexpected summary";
        },
      },
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("downloads are disabled in this read-only session");
    expect(summaryCalls).toBe(0);
    expect(readdirSync(cwd)).toEqual([]);
  });

  test("removes a partial file if a download stream fails", async () => {
    const cwd = workspace();
    const brokenBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.error(new Error("broken download"));
      },
    });
    const result = await browseInternalsForTest.executeBrowse(
      { url: "https://cdn.example.test/broken.bin", prompt: "get it" },
      { cwd },
      undefined,
      {
        fetch: async () => new Response(brokenBody, { headers: { "content-type": "application/octet-stream" } }),
        summarize: async () => "unexpected summary",
      },
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("broken download");
    expect(readdirSync(cwd)).toEqual([]);
  });

  test("rejects unknown download modes before fetching", async () => {
    let fetchCalls = 0;
    const result = await browseInternalsForTest.executeBrowse(
      { url: "https://example.test/asset", mode: "raw" },
      undefined,
      undefined,
      {
        fetch: async () => {
          fetchCalls++;
          return new Response("unexpected");
        },
        summarize: async () => "unexpected",
      },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("'mode' must be either 'auto' or 'download'");
    expect(fetchCalls).toBe(0);
  });
});

describe("browse vimbrowser fallback", () => {
  test("uses the exact browser-profile downloader for a forced download after HTTP 403", async () => {
    const cwd = workspace();
    const path = join(cwd, "authenticated.js");
    const bytes = Buffer.from("authenticated exact bytes\n");
    let pageFallbackCalls = 0;
    let downloadFallbackCalls = 0;
    let summaryCalls = 0;
    const vimbrowserFetch = Object.assign(
      async () => {
        pageFallbackCalls++;
        return null;
      },
      {
        download: async (url: string, directory: string) => {
          downloadFallbackCalls++;
          expect(directory).toBe(cwd);
          writeFileSync(path, bytes);
          return {
            bytes: bytes.length,
            contentType: "application/javascript",
            downloadPath: path,
            pageUrl: url,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          };
        },
      },
    );

    const result = await browseInternalsForTest.executeBrowse(
      { url: "https://blocked.example.test/authenticated.js", mode: "download" },
      { cwd },
      undefined,
      {
        fetch: async () => new Response("blocked", { status: 403, statusText: "Forbidden" }),
        vimbrowserFetch,
        summarize: async () => {
          summaryCalls++;
          return "unexpected summary";
        },
      },
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain(path);
    expect(result.output).toContain(createHash("sha256").update(bytes).digest("hex"));
    expect(downloadFallbackCalls).toBe(1);
    expect(pageFallbackCalls).toBe(0);
    expect(summaryCalls).toBe(0);
  });

  test("never substitutes rendered HTML when an exact browser download is unavailable", async () => {
    let pageFallbackCalls = 0;
    let summaryCalls = 0;
    const vimbrowserFetch = Object.assign(
      async () => {
        pageFallbackCalls++;
        return {
          html: "<main>This rendered page is not the response payload.</main>",
          pageUrl: "https://blocked.example.test/asset.js",
        };
      },
      { download: async () => null },
    );

    const result = await browseInternalsForTest.executeBrowse(
      { url: "https://blocked.example.test/asset.js", mode: "download" },
      undefined,
      undefined,
      {
        fetch: async () => new Response("blocked", { status: 403, statusText: "Forbidden" }),
        vimbrowserFetch,
        summarize: async () => {
          summaryCalls++;
          return "unexpected summary";
        },
      },
    );

    expect(result).toEqual({
      output: "Error fetching https://blocked.example.test/asset.js: HTTP 403 Forbidden",
      isError: true,
    });
    expect(pageFallbackCalls).toBe(0);
    expect(summaryCalls).toBe(0);
  });

  test("uses rendered browser HTML after a direct HTTP 403", async () => {
    let fallbackUrl = "";
    let summarizedMarkdown = "";
    const result = await browseInternalsForTest.executeBrowse(
      { url: "https://blocked.example.test/page", prompt: "find the answer" },
      undefined,
      undefined,
      {
        fetch: async () => new Response("blocked", { status: 403, statusText: "Forbidden" }),
        vimbrowserFetch: async url => {
          fallbackUrl = url;
          return {
            html: "<main><h1>Rendered answer</h1><p>It worked.</p></main>",
            pageUrl: url,
          };
        },
        summarize: async (_url, markdown) => {
          summarizedMarkdown = markdown;
          return "browser-backed summary";
        },
      },
    );

    expect(fallbackUrl).toBe("https://blocked.example.test/page");
    expect(summarizedMarkdown).toContain("Rendered answer");
    expect(result).toEqual({ output: "browser-backed summary", isError: false });
  });

  test("preserves the original 403 when vimbrowser is unavailable", async () => {
    const result = await browseInternalsForTest.executeBrowse(
      { url: "https://unavailable.example.test/page", prompt: "read it" },
      undefined,
      undefined,
      {
        fetch: async () => new Response("blocked", { status: 403, statusText: "Forbidden" }),
        vimbrowserFetch: async () => null,
        summarize: async () => "unexpected summary",
      },
    );

    expect(result).toEqual({
      output: "Error fetching https://unavailable.example.test/page: HTTP 403 Forbidden",
      isError: true,
    });
  });

  test("does not use vimbrowser for non-403 HTTP errors", async () => {
    let fallbackCalls = 0;
    const result = await browseInternalsForTest.executeBrowse(
      { url: "https://missing.example.test/page", prompt: "read it" },
      undefined,
      undefined,
      {
        fetch: async () => new Response("missing", { status: 404, statusText: "Not Found" }),
        vimbrowserFetch: async () => {
          fallbackCalls++;
          return null;
        },
        summarize: async () => "unexpected summary",
      },
    );

    expect(fallbackCalls).toBe(0);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("HTTP 404 Not Found");
  });

  test("retains cross-host redirect protection for browser-loaded pages", async () => {
    const result = await browseInternalsForTest.executeBrowse(
      { url: "https://redirected.example.test/page", prompt: "read it" },
      undefined,
      undefined,
      {
        fetch: async () => new Response("blocked", { status: 403, statusText: "Forbidden" }),
        vimbrowserFetch: async () => ({
          html: "<main>Signed-in destination</main>",
          pageUrl: "https://login.example.test/session",
        }),
        summarize: async () => "unexpected summary",
      },
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("URL redirected to a different host");
    expect(result.output).toContain("https://login.example.test/session");
  });
});
