import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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

  test("tells the model that direct downloads bypass AI interpretation", () => {
    const source = readFileSync(join(import.meta.dir, "browse.ts"), "utf8");
    expect(source).toContain("Direct downloads and binary responses are saved to the conversation workspace without AI interpretation.");
  });

  test("does not import deterministic browse helpers", () => {
    const source = readFileSync(join(import.meta.dir, "browse.ts"), "utf8");
    expect(source).not.toContain('from "./browse/index"');
    expect(source).not.toContain("extractRelevantLinks(");
    expect(source).not.toContain("buildRelevantLinksSection(");
  });
});

describe("browse direct downloads", () => {
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
});
