/**
 * Clipboard image reading via xclip.
 *
 * Reads image data from the system clipboard and returns it
 * as a base64-encoded ImageAttachment for the Anthropic API.
 */

import { spawnSync } from "child_process";
import type { ImageAttachment, ImageMediaType } from "./messages";

/** Read an image from the system clipboard. Returns null if no image is available. */
export function readClipboardImage(): ImageAttachment | null {
  try {
    // Check what MIME types are available on the clipboard
    const targets = spawnSync("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], { timeout: 1000 });
    if (targets.status !== 0 || !targets.stdout) return null;
    const available = targets.stdout.toString();

    // Try image formats in order of preference
    const formats: { mime: ImageMediaType; target: string }[] = [
      { mime: "image/png", target: "image/png" },
      { mime: "image/jpeg", target: "image/jpeg" },
      { mime: "image/gif", target: "image/gif" },
      { mime: "image/webp", target: "image/webp" },
    ];

    for (const fmt of formats) {
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
  } catch {}
  return null;
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
