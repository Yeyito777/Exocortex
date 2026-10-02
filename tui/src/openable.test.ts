import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultExocortexConfig, writeExocortexConfig } from "@exocortex/shared/config";
import { canOpenLinkTarget, findOpenableTargetMatches, openTargetDetached, resolveOpenCommand } from "./openable";
import { homedir, tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function resetConfig(): void {
  writeExocortexConfig(defaultExocortexConfig());
}

beforeEach(resetConfig);
afterEach(resetConfig);

describe("openable target detection", () => {
  test("detects image, pdf, and audio/video paths", () => {
    expect(findOpenableTargetMatches("/tmp/a.png /tmp/b.webp /tmp/c.pdf /tmp/d.mp3 /tmp/e.mov").map((m) => m.target)).toEqual([
      "/tmp/a.png",
      "/tmp/b.webp",
      "/tmp/c.pdf",
      "/tmp/d.mp3",
      "/tmp/e.mov",
    ]);
  });

  test("detects relative and home-prefixed configured file paths", () => {
    expect(findOpenableTargetMatches("./out/a.md ../b.py ~/notes/c.txt ./page.html").map((m) => m.target)).toEqual([
      "./out/a.md",
      "../b.py",
      "~/notes/c.txt",
      "./page.html",
    ]);
  });

  test("keeps filename apostrophes but drops surrounding prose quotes", () => {
    expect(findOpenableTargetMatches("'/tmp/it's.py' \"/tmp/notes.md\"").map(m => m.target))
      .toEqual(["/tmp/it's.py", "/tmp/notes.md"]);
  });

  test("detects http and https links", () => {
    expect(findOpenableTargetMatches("See https://example.com/a?b=1 and http://localhost:3000.").map((m) => m.target)).toEqual([
      "https://example.com/a?b=1",
      "http://localhost:3000",
    ]);
  });

  test("does not double-detect URL paths as local files", () => {
    expect(findOpenableTargetMatches("https://example.com/reference.png")).toEqual([
      { target: "https://example.com/reference.png", start: 0, end: "https://example.com/reference.png".length },
    ]);
  });

  test("ignores unconfigured file extensions", () => {
    expect(findOpenableTargetMatches("/tmp/archive.zip")).toEqual([]);
  });

  test("does not open a prefix of an unconfigured extension or a disabled URL", () => {
    expect(findOpenableTargetMatches("/tmp/a.md.zip")).toEqual([]);
    writeExocortexConfig({ openers: { url: null } });
    expect(findOpenableTargetMatches("https://example.com/a.md")).toEqual([]);
  });
});

describe("configured text-file rules", () => {
  test("matches existing text files of any extension and extensionless files", () => {
    const directory = mkdtempSync(join(tmpdir(), "exocortex-text-openers-"));
    try {
      writeExocortexConfig({
        openers: { rules: [
          { extensions: ["pdf"], command: "pdf-viewer", args: ["{path}"] },
          { text: true, command: "terminal", args: ["-e", "editor", "--", "{path}"] },
        ] },
      });
      for (const name of ["notes.md", "script.py", "data.json", "code.rs", ".gitignore", "Makefile", "it's $(literal).txt"]) {
        const path = join(directory, name);
        writeFileSync(path, "中文 text\n");
        const options = { baseDirectory: directory, localLink: true };
        expect(resolveOpenCommand(name, options)).toEqual({
          command: "terminal", args: ["-e", "editor", "--", path],
        });
      }
      expect(resolveOpenCommand("file://" + directory + "/data.json", { localLink: true })).toEqual({
        command: "terminal", args: ["-e", "editor", "--", join(directory, "data.json")],
      });
      // Rules remain ordered; explicit extensions can opt in without a file.
      expect(resolveOpenCommand(join(directory, "not-created.pdf"))?.command).toBe("pdf-viewer");
      const binary = join(directory, "binary.dat");
      writeFileSync(binary, Buffer.from([0, 1, 2, 0xff]));
      expect(resolveOpenCommand(binary)).toBeNull();
      expect(resolveOpenCommand(binary, { localLink: true })).toEqual({ command: "xdg-open", args: [binary] });
      expect(resolveOpenCommand(directory, { localLink: true })?.command).toBe("xdg-open");
      expect(resolveOpenCommand(join(directory, "missing.unknown"))).toBeNull();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("combines extension opt-ins with content detection and obeys config changes", () => {
    writeExocortexConfig({ openers: { rules: [
      { text: true, extensions: [".MD", "py"], command: "st", args: ["-e", "nvim", "--", "{path}"] },
    ] } });
    expect(resolveOpenCommand("/not-created/notes.md")).toEqual({
      command: "st", args: ["-e", "nvim", "--", "/not-created/notes.md"],
    });
    writeExocortexConfig({ openers: { rules: [] } });
    expect(resolveOpenCommand("/not-created/notes.md")).toBeNull();
    expect(findOpenableTargetMatches("/not-created/notes.md")).toEqual([]);
  });

  test("history recognition never requires local files, including remote paths", () => {
    writeExocortexConfig({ openers: { url: null, rules: [
      { text: true, command: "custom-editor", args: ["{path}"] },
    ] } });
    expect(findOpenableTargetMatches("Files: /remote/Makefile ./src/main.rs ~/notes/.env file:///remote/a%20b.json.").map(m => m.target))
      .toEqual(["/remote/Makefile", "./src/main.rs", "~/notes/.env", "file:///remote/a%20b.json"]);
    expect(canOpenLinkTarget("remote/file.rs")).toBe(true);
    expect(canOpenLinkTarget("https://example.com")).toBe(false);
    expect(findOpenableTargetMatches("https://example.com/file.rs javascript:/remote/file.rs")).toEqual([]);
  });

  test("ignores invalid or disabled text rules", () => {
    writeExocortexConfig({ openers: { rules: [{ text: false, command: "editor" }] } });
    expect(findOpenableTargetMatches("/remote/Makefile")).toEqual([]);
  });
});

describe("openable target command resolution", () => {
  test("resolves local links relative to the conversation and decodes file URIs", () => {
    const options = { baseDirectory: "/tmp/conversation", localLink: true };
    for (const [target, path] of [
      ["NFC-Findings/README.md", "/tmp/conversation/NFC-Findings/README.md"],
      ["../notes.md", "/tmp/notes.md"],
      ["~/notes.md", `${homedir()}/notes.md`],
      ["file:///tmp/notes%20one.md", "/tmp/notes one.md"],
      ["notes%20one.md", "/tmp/conversation/notes one.md"],
    ]) {
      expect(resolveOpenCommand(target, options)).toEqual({
        command: "st", args: ["-e", "zsh", "-ic", `exec nvim '${path}'`],
      });
    }
    for (const target of ["NFC-Findings/", "evidence.json", "SHA256SUMS"]) {
      expect(resolveOpenCommand(target, options)).toEqual({
        command: "xdg-open", args: [`/tmp/conversation/${target.replace(/\/$/, "")}`],
      });
    }
  });

  test("local fallback never opens unsafe schemes or control characters", () => {
    for (const target of [
      "javascript:notes.md", "data:text/plain,notes.md", "file://remote/tmp/notes.md",
      "notes%00.md", "notes\n.md", "file:///tmp/notes%1b.md", "//remote/notes.md",
    ]) {
      expect(resolveOpenCommand(target, { localLink: true })).toBeNull();
    }
  });

  test("opens image and pdf paths with show", () => {
    expect(resolveOpenCommand("/tmp/reference.png")).toEqual({ command: "show", args: ["/tmp/reference.png"] });
    expect(resolveOpenCommand("/tmp/reference.pdf")).toEqual({ command: "show", args: ["/tmp/reference.pdf"] });
  });

  test("opens links with xdg-open", () => {
    expect(resolveOpenCommand("https://example.com")).toEqual({ command: "xdg-open", args: ["https://example.com"] });
  });

  test("opens html paths with xdg-open", () => {
    expect(resolveOpenCommand("/tmp/page.html")).toEqual({ command: "xdg-open", args: ["/tmp/page.html"] });
  });

  test("opens audio/video paths with audio-play inside an ephemeral st terminal", () => {
    expect(resolveOpenCommand("/tmp/song.mp3")).toEqual({
      command: "st",
      args: ["-e", "zsh", "-ic", "exec audio-play '/tmp/song.mp3'"],
    });
    expect(resolveOpenCommand("/tmp/clip.mov")).toEqual({
      command: "st",
      args: ["-e", "zsh", "-ic", "exec audio-play '/tmp/clip.mov'"],
    });
  });

  test("opens code/text paths in nvim inside an ephemeral st terminal", () => {
    expect(resolveOpenCommand("/tmp/notes.md")).toEqual({
      command: "st",
      args: ["-e", "zsh", "-ic", "exec nvim '/tmp/notes.md'"],
    });
  });

  test("quotes terminal-opened paths before passing them through zsh", () => {
    expect(resolveOpenCommand("/tmp/it's tricky.py")).toEqual({
      command: "st",
      args: ["-e", "zsh", "-ic", "exec nvim '/tmp/it'\\''s tricky.py'"],
    });
    expect(resolveOpenCommand("/tmp/it's tricky.mp3")).toEqual({
      command: "st",
      args: ["-e", "zsh", "-ic", "exec audio-play '/tmp/it'\\''s tricky.mp3'"],
    });
  });

  test("does not open unconfigured extensions", () => {
    expect(resolveOpenCommand("/tmp/archive.zip")).toBeNull();
    expect(openTargetDetached("/tmp/archive.zip")).toBe(false);
  });

  test("uses opener commands configured in config.json", () => {
    writeExocortexConfig({
      theme: "whale",
      openers: {
        url: { command: "browser", args: ["--new-tab", "{target}"] },
        rules: [
          { extensions: ["png"], command: "image-viewer", args: ["{path}"] },
          { extensions: ["log"], command: "term", args: ["-e", "editor {path:sh}"] },
        ],
      },
    });

    expect(findOpenableTargetMatches("/tmp/a.png /tmp/b.md /tmp/c.log https://example.com").map((m) => m.target)).toEqual([
      "/tmp/a.png",
      "/tmp/c.log",
      "https://example.com",
    ]);
    expect(resolveOpenCommand("https://example.com")).toEqual({
      command: "browser",
      args: ["--new-tab", "https://example.com"],
    });
    expect(resolveOpenCommand("/tmp/a.png")).toEqual({ command: "image-viewer", args: ["/tmp/a.png"] });
    expect(resolveOpenCommand("/tmp/it's tricky.log")).toEqual({
      command: "term",
      args: ["-e", "editor '/tmp/it'\\''s tricky.log'"],
    });
    expect(resolveOpenCommand("/tmp/b.md")).toBeNull();
  });

  test("can disable link opening from config.json", () => {
    writeExocortexConfig({
      theme: "whale",
      openers: {
        url: null,
        rules: [{ extensions: ["txt"], command: "viewer", args: ["{path}"] }],
      },
    });

    expect(findOpenableTargetMatches("https://example.com /tmp/a.txt").map((m) => m.target)).toEqual(["/tmp/a.txt"]);
    expect(resolveOpenCommand("https://example.com")).toBeNull();
  });
});
