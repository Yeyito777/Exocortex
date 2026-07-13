/**
 * Clipboard image reading.
 *
 * Reads image data from the system clipboard and returns it
 * as a base64-encoded ImageAttachment for provider vision inputs.
 *
 * Supports macOS (AppleScript), X11 (xclip), Wayland (wl-paste), and
 * Windows (PowerShell).
 */

import { spawnSync, type SpawnSyncReturns } from "child_process";
import { readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import type { ImageAttachment, ImageMediaType } from "./messages";
import { log } from "./log";

// ── Backend detection ────────────────────────────────────────────

type ImageClipboardBackend = "osascript" | "xclip" | "wl" | "powershell" | null;

interface ClipboardSystem {
  spawnSync: typeof spawnSync;
  readFileSync: typeof readFileSync;
  unlinkSync: typeof unlinkSync;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  tmpPath: () => string;
}

const defaultClipboardSystem: ClipboardSystem = {
  spawnSync,
  readFileSync,
  unlinkSync,
  platform: process.platform,
  env: process.env,
  tmpPath: () => join(tmpdir(), `exocortex-clipboard-${process.pid}-${Date.now()}-${randomUUID()}.png`),
};

let clipboardSystem: ClipboardSystem = defaultClipboardSystem;

export function setClipboardSystemForTest(overrides: Partial<ClipboardSystem> | null): void {
  clipboardSystem = overrides ? { ...defaultClipboardSystem, ...overrides } : defaultClipboardSystem;
  backend = undefined;
}

let backend: ImageClipboardBackend | undefined;

function detectBackend(): ImageClipboardBackend {
  if (backend !== undefined) return backend;

  // Windows — PowerShell is always available
  if (clipboardSystem.platform === "win32") { backend = "powershell"; return backend; }

  // macOS — AppleScript can coerce clipboard images into PNG without extra deps.
  if (clipboardSystem.platform === "darwin") {
    try {
      const r = clipboardSystem.spawnSync("which", ["osascript"], { timeout: 1000 });
      if (r.status === 0) { backend = "osascript"; return backend; }
    } catch { /* osascript not available */ }
  }

  // Check for Wayland first
  if (clipboardSystem.env.WAYLAND_DISPLAY) {
    try {
      const r = clipboardSystem.spawnSync("which", ["wl-paste"], { timeout: 1000 });
      if (r.status === 0) { backend = "wl"; return backend; }
    } catch { /* wl-paste not available */ }
  }

  // X11
  try {
    const r = clipboardSystem.spawnSync("which", ["xclip"], { timeout: 1000 });
    if (r.status === 0) { backend = "xclip"; return backend; }
  } catch { /* xclip not available */ }

  backend = null;
  return backend;
}

// ── Diagnostics ───────────────────────────────────────────────────

const LOG_SNIPPET_CHARS = 240;

function compactOneLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function snippet(text: string, maxChars = LOG_SNIPPET_CHARS): string {
  const compact = compactOneLine(text);
  return compact.length > maxChars ? `${compact.slice(0, maxChars)}…` : compact;
}

function decodeOutput(output: Buffer | string | null | undefined): string {
  if (!output) return "";
  return typeof output === "string" ? output : output.toString("utf8");
}

function targetList(available: string): string {
  const targets = available
    .split(/[\r\n]+/)
    .map(t => t.trim())
    .filter(Boolean);
  if (targets.length === 0) return "<none>";
  const shown = targets.slice(0, 20).join(", ");
  return targets.length > 20 ? `${shown}, … (+${targets.length - 20} more)` : shown;
}

function spawnFailureSummary(result: SpawnSyncReturns<Buffer>): string {
  const parts: string[] = [];
  if (result.status !== null) parts.push(`status=${result.status}`);
  if (result.signal) parts.push(`signal=${result.signal}`);
  if (result.error) parts.push(`error=${result.error.message}`);
  const stderr = snippet(decodeOutput(result.stderr));
  if (stderr) parts.push(`stderr=${JSON.stringify(stderr)}`);
  return parts.length > 0 ? parts.join(", ") : "no status/error/stderr reported";
}

function logImagePasteFailure(reason: string): void {
  log("warn", `tui: clipboard image paste failed: ${reason}`);
}

function appleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ── Image formats ────────────────────────────────────────────────

const IMAGE_FORMATS: { mime: ImageMediaType; target: string }[] = [
  { mime: "image/png", target: "image/png" },
  { mime: "image/jpeg", target: "image/jpeg" },
  { mime: "image/gif", target: "image/gif" },
  { mime: "image/webp", target: "image/webp" },
];

function detectImageMediaType(buf: Buffer): ImageMediaType | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (buf.length >= 6 && (buf.subarray(0, 6).toString("ascii") === "GIF87a" || buf.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return "image/gif";
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return null;
}

function buildImageAttachment(mediaType: ImageMediaType, buf: Buffer): ImageAttachment | null {
  // Some clipboard owners advertise image/png but return a non-image payload for
  // that target. If we accept it, the provider rejects the entire request with
  // “image data ... does not represent a valid image”. Validate the bytes before
  // attaching them so one bad clipboard target cannot poison the conversation.
  if (detectImageMediaType(buf) !== mediaType) return null;
  return {
    mediaType,
    base64: buf.toString("base64"),
    sizeBytes: buf.length,
  };
}

function invalidImageReason(expected: ImageMediaType, buf: Buffer): string | null {
  const actual = detectImageMediaType(buf);
  if (actual === expected) return null;
  return `target ${expected} returned ${buf.length} byte(s), but detected ${actual ?? "non-image/unknown"} bytes`;
}

// ── Backend implementations ──────────────────────────────────────

function readImageXclip(): ImageAttachment | null {
  const targets = clipboardSystem.spawnSync("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], { timeout: 1000 });
  if (targets.status !== 0) {
    logImagePasteFailure(`xclip TARGETS query failed (${spawnFailureSummary(targets)})`);
    return null;
  }
  if (!targets.stdout || targets.stdout.length === 0) {
    logImagePasteFailure("xclip TARGETS query returned no clipboard targets");
    return null;
  }
  const available = targets.stdout.toString();
  const attempted: string[] = [];

  for (const fmt of IMAGE_FORMATS) {
    if (!available.includes(fmt.target)) continue;
    attempted.push(fmt.target);
    const result = clipboardSystem.spawnSync("xclip", ["-selection", "clipboard", "-t", fmt.target, "-o"], {
      timeout: 5000,
      maxBuffer: 50 * 1024 * 1024,  // 50 MB
    });
    if (result.status !== 0) {
      logImagePasteFailure(`xclip read for ${fmt.target} failed (${spawnFailureSummary(result)})`);
      continue;
    }
    if (!result.stdout || result.stdout.length === 0) {
      logImagePasteFailure(`xclip read for ${fmt.target} returned an empty payload`);
      continue;
    }
    const buf = Buffer.from(result.stdout);
    const invalidReason = invalidImageReason(fmt.mime, buf);
    if (invalidReason) {
      logImagePasteFailure(`xclip ${invalidReason}`);
      continue;
    }
    const attachment = buildImageAttachment(fmt.mime, buf);
    if (attachment) return attachment;
  }
  if (attempted.length === 0) {
    logImagePasteFailure(`xclip clipboard has no supported image target; available targets: ${targetList(available)}`);
  } else {
    logImagePasteFailure(`xclip found supported target(s) [${attempted.join(", ")}] but none produced a valid supported image; available targets: ${targetList(available)}`);
  }
  return null;
}

function readImageWayland(): ImageAttachment | null {
  const targets = clipboardSystem.spawnSync("wl-paste", ["--list-types"], { timeout: 1000 });
  if (targets.status !== 0) {
    logImagePasteFailure(`wl-paste --list-types failed (${spawnFailureSummary(targets)})`);
    return null;
  }
  if (!targets.stdout || targets.stdout.length === 0) {
    logImagePasteFailure("wl-paste --list-types returned no clipboard targets");
    return null;
  }
  const available = targets.stdout.toString();
  const attempted: string[] = [];

  for (const fmt of IMAGE_FORMATS) {
    if (!available.includes(fmt.target)) continue;
    attempted.push(fmt.target);
    const result = clipboardSystem.spawnSync("wl-paste", ["--type", fmt.target], {
      timeout: 5000,
      maxBuffer: 50 * 1024 * 1024,  // 50 MB
    });
    if (result.status !== 0) {
      logImagePasteFailure(`wl-paste read for ${fmt.target} failed (${spawnFailureSummary(result)})`);
      continue;
    }
    if (!result.stdout || result.stdout.length === 0) {
      logImagePasteFailure(`wl-paste read for ${fmt.target} returned an empty payload`);
      continue;
    }
    const buf = Buffer.from(result.stdout);
    const invalidReason = invalidImageReason(fmt.mime, buf);
    if (invalidReason) {
      logImagePasteFailure(`wl-paste ${invalidReason}`);
      continue;
    }
    const attachment = buildImageAttachment(fmt.mime, buf);
    if (attachment) return attachment;
  }
  if (attempted.length === 0) {
    logImagePasteFailure(`wl-paste clipboard has no supported image target; available targets: ${targetList(available)}`);
  } else {
    logImagePasteFailure(`wl-paste found supported target(s) [${attempted.join(", ")}] but none produced a valid supported image; available targets: ${targetList(available)}`);
  }
  return null;
}

function readImagePowerShell(): ImageAttachment | null {
  // Always saves as PNG regardless of original clipboard format.
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$img = [System.Windows.Forms.Clipboard]::GetImage()",
    "if ($img) {",
    "  try {",
    "    $path = [System.IO.Path]::GetTempFileName()",
    "    $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)",
    "    Write-Output $path",
    "  } finally {",
    "    $img.Dispose()",
    "  }",
    "}",
  ].join("\n");

  const result = clipboardSystem.spawnSync("powershell", ["-NoProfile", "-Command", script], { timeout: 5000 });
  if (result.status !== 0) {
    logImagePasteFailure(`PowerShell clipboard image extraction failed (${spawnFailureSummary(result)})`);
    return null;
  }
  if (!result.stdout || result.stdout.length === 0) {
    logImagePasteFailure("PowerShell clipboard image extraction returned no temp file path");
    return null;
  }

  const tmpPath = result.stdout.toString().trim();
  if (!tmpPath) {
    logImagePasteFailure("PowerShell clipboard image extraction returned an empty temp file path");
    return null;
  }

  try {
    const buf = clipboardSystem.readFileSync(tmpPath);
    if (buf.length === 0) {
      logImagePasteFailure(`PowerShell clipboard image extraction wrote an empty temp file: ${tmpPath}`);
      return null;
    }
    const invalidReason = invalidImageReason("image/png", buf);
    if (invalidReason) {
      logImagePasteFailure(`PowerShell ${invalidReason}`);
      return null;
    }
    return buildImageAttachment("image/png", buf);
  } finally {
    try { clipboardSystem.unlinkSync(tmpPath); } catch { /* already gone */ }
  }
}

function readImageAppleScript(): ImageAttachment | null {
  const tmpPath = clipboardSystem.tmpPath();
  const script = [
    "set outFile to missing value",
    "try",
    "  set pngData to the clipboard as «class PNGf»",
    `  set outFile to open for access (POSIX file "${appleScriptString(tmpPath)}") with write permission`,
    "  set eof outFile to 0",
    "  write pngData to outFile",
    "  close access outFile",
    "on error errMsg number errNo",
    "  try",
    "    if outFile is not missing value then close access outFile",
    "  end try",
    "  error errMsg number errNo",
    "end try",
  ];

  try {
    const result = clipboardSystem.spawnSync("osascript", script.flatMap(line => ["-e", line]), {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0) {
      logImagePasteFailure(`AppleScript clipboard image extraction failed (${spawnFailureSummary(result)})`);
      return null;
    }

    const buf = clipboardSystem.readFileSync(tmpPath);
    if (buf.length === 0) {
      logImagePasteFailure(`AppleScript clipboard image extraction wrote an empty temp file: ${tmpPath}`);
      return null;
    }
    const invalidReason = invalidImageReason("image/png", buf);
    if (invalidReason) {
      logImagePasteFailure(`AppleScript ${invalidReason}`);
      return null;
    }
    return buildImageAttachment("image/png", buf);
  } finally {
    try { clipboardSystem.unlinkSync(tmpPath); } catch { /* already gone */ }
  }
}

// ── Public API ───────────────────────────────────────────────────

/** Read an image from the system clipboard. Returns null if no image is available. */
export function readClipboardImage(): ImageAttachment | null {
  try {
    const be = detectBackend();
    if (!be) {
      logImagePasteFailure("no clipboard image backend available (need osascript on macOS, xclip on X11, wl-paste on Wayland, or PowerShell on Windows)");
      return null;
    }
    if (be === "osascript") return readImageAppleScript();
    if (be === "powershell") return readImagePowerShell();
    return be === "wl" ? readImageWayland() : readImageXclip();
  } catch (err) {
    logImagePasteFailure(`unexpected error while reading clipboard image: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Format a byte size for display (e.g. "93.1 KB"). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Extract a short extension label from a media type (e.g. "image/png" → "PNG"). */
export function imageLabel(mediaType: string): string {
  const ext = mediaType.split("/")[1]?.toUpperCase() ?? "IMG";
  return ext === "JPEG" ? "JPG" : ext;
}
