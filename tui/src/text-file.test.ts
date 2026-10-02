import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isEditableTextFile } from "./text-file";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(content: string | Buffer): string {
  const directory = mkdtempSync(join(tmpdir(), "exocortex-text-file-"));
  directories.push(directory);
  const path = join(directory, "sample");
  writeFileSync(path, content);
  return path;
}

describe("editable text detection", () => {
  test("accepts empty, ASCII, UTF-8, and BOM-marked UTF-16 text", () => {
    for (const content of ["", "plain\n\ttext\r\n", "中文 café 😀", "\ufeffnotes",
      Buffer.from("\ufeff中文\n", "utf16le"), Buffer.from([0xfe, 0xff, 0, 0x41, 0, 0x0a])]) {
      expect(isEditableTextFile(fixture(content))).toBe(true);
    }
  });

  test("rejects NULs, invalid encodings, and binary controls", () => {
    for (const content of ["a\0b", Buffer.from([0xff, 0, 0xff]), Buffer.from([0xff]),
      "\u0001\u0002\u0003", Buffer.from([0xff, 0xfe, 0x41])]) {
      expect(isEditableTextFile(fixture(content))).toBe(false);
    }
  });

  test("handles a UTF-8 character straddling the sample boundary", () => {
    expect(isEditableTextFile(fixture("x".repeat(8191) + "😀"))).toBe(true);
  });

  test("rejects missing files, directories, and FIFOs without blocking", () => {
    const path = fixture("text");
    const directory = directories.at(-1)!;
    expect(isEditableTextFile(path + ".missing")).toBe(false);
    expect(isEditableTextFile(directory)).toBe(false);
    if (process.platform !== "win32") {
      const fifo = join(directory, "fifo");
      expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
      expect(isEditableTextFile(fifo)).toBe(false);
    }
  });

  test("follows ordinary file symlinks", () => {
    const path = fixture("text");
    const link = path + ".link";
    symlinkSync(path, link);
    expect(isEditableTextFile(link)).toBe(true);
  });
});
