import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultExocortexConfig, writeExocortexConfig } from "@exocortex/shared/config";
import { findOpenableTargetMatches, openTargetDetached, resolveOpenCommand } from "./openable";

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
    expect(findOpenableTargetMatches("./out/a.md ../b.py ~/notes/c.txt").map((m) => m.target)).toEqual([
      "./out/a.md",
      "../b.py",
      "~/notes/c.txt",
    ]);
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
});

describe("openable target command resolution", () => {
  test("opens image and pdf paths with show", () => {
    expect(resolveOpenCommand("/tmp/reference.png")).toEqual({ command: "show", args: ["/tmp/reference.png"] });
    expect(resolveOpenCommand("/tmp/reference.pdf")).toEqual({ command: "show", args: ["/tmp/reference.pdf"] });
  });

  test("opens links with xdg-open", () => {
    expect(resolveOpenCommand("https://example.com")).toEqual({ command: "xdg-open", args: ["https://example.com"] });
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
