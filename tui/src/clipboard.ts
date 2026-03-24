/**
 * Clipboard image reading.
 *
 * Reads image data from the system clipboard and returns it
 * as a base64-encoded ImageAttachment for the Anthropic API.
 *
 * Supports X11 (xclip), Wayland (wl-paste), and Windows (PowerShell).
 */

import { spawnSync } from "child_process";
import { readFileSync, unlinkSync } from "fs";
import { isWindows } from "@exocortex/shared/paths";
import type { ImageAttachment, ImageMediaType } from "./messages";

// ── Backend detection ────────────────────────────────────────────

type ImageClipboardBackend = "xclip" | "wl" | "powershell" | null;

let backend: ImageClipboardBackend | undefined;

function detectBackend(): ImageClipboardBackend {
  if (backend !== undefined) return backend;

  // Windows — PowerShell is always available
  if (isWindows) { backend = "powershell"; return backend; }

  // Check for Wayland first
  if (process.env.WAYLAND_DISPLAY) {
    try {
      const r = spawnSync("which", ["wl-paste"], { timeout: 1000 });
      if (r.status === 0) { backend = "wl"; return backend; }
    } catch { /* wl-paste not available */ }
  }

  // X11
  try {
    const r = spawnSync("which", ["xclip"], { timeout: 1000 });
    if (r.status === 0) { backend = "xclip"; return backend; }
  } catch { /* xclip not available */ }

  backend = null;
  return backend;
}

// ── Image formats ────────────────────────────────────────────────

const IMAGE_FORMATS: { mime: ImageMediaType; target: string }[] = [
  { mime: "image/png", target: "image/png" },
  { mime: "image/jpeg", target: "image/jpeg" },
  { mime: "image/gif", target: "image/gif" },
  { mime: "image/webp", target: "image/webp" },
];

// ── Backend implementations ──────────────────────────────────────

function readImageXclip(): ImageAttachment | null {
  const targets = spawnSync("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], { timeout: 1000 });
  if (targets.status !== 0 || !targets.stdout) return null;
  const available = targets.stdout.toString();

  for (const fmt of IMAGE_FORMATS) {
    if (!available.includes(fmt.target)) continue;
    const result = spawnSync("xclip", ["-selection", "clipboard", "-t", fmt.target, "-o"], {
      timeout: 5000,
      maxBuffer: 50 * 1024 * 1024,  // 50 MB
    });
    if (result.status !== 0 || !result.stdout || result.stdout.length === 0) continue;
    return {
      mediaType: fmt.mime,
      base64: Buffer.from(result.stdout).toString("base64"),
      sizeBytes: result.stdout.length,
    };
  }
  return null;
}

function readImageWayland(): ImageAttachment | null {
  const targets = spawnSync("wl-paste", ["--list-types"], { timeout: 1000 });
  if (targets.status !== 0 || !targets.stdout) return null;
  const available = targets.stdout.toString();

  for (const fmt of IMAGE_FORMATS) {
    if (!available.includes(fmt.target)) continue;
    const result = spawnSync("wl-paste", ["--type", fmt.target], {
      timeout: 5000,
      maxBuffer: 50 * 1024 * 1024,  // 50 MB
    });
    if (result.status !== 0 || !result.stdout || result.stdout.length === 0) continue;
    return {
      mediaType: fmt.mime,
      base64: Buffer.from(result.stdout).toString("base64"),
      sizeBytes: result.stdout.length,
    };
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

  const result = spawnSync("powershell", ["-NoProfile", "-Command", script], { timeout: 5000 });
  if (result.status !== 0 || !result.stdout) return null;

  const tmpPath = result.stdout.toString().trim();
  if (!tmpPath) return null;

  try {
    const buf = readFileSync(tmpPath);
    if (buf.length === 0) return null;
    return {
      mediaType: "image/png",
      base64: buf.toString("base64"),
      sizeBytes: buf.length,
    };
  } finally {
    try { unlinkSync(tmpPath); } catch { /* already gone */ }
  }
}

// ── Public API ───────────────────────────────────────────────────

/** Read an image from the system clipboard. Returns null if no image is available. */
export function readClipboardImage(): ImageAttachment | null {
  try {
    const be = detectBackend();
    if (!be) return null;
    if (be === "powershell") return readImagePowerShell();
    return be === "wl" ? readImageWayland() : readImageXclip();
  } catch {
    // Missing tool or unexpected error — degrade silently
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
