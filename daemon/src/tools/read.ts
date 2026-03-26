/**
 * Read tool — read files from the local filesystem.
 *
 * Text files: returns content with cat -n style line numbers.
 * Image files: returns base64-encoded image data for Claude's vision.
 * Supports offset/limit for partial reads.
 */

import type { Tool, ToolResult, ToolSummary } from "./types";
import { cap, getString, getNumber, safeSlice, summarizeParams } from "./util";
import { log } from "../log";

// ── Constants ──────────────────────────────────────────────────────

const DEFAULT_LINE_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;

// ── Image handling ─────────────────────────────────────────────────

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp",
  ".bmp", ".tiff", ".tif", ".svg", ".avif", ".ico",
]);

const SUPPORTED_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const MAX_BASE64_BYTES = 5 * 1024 * 1024;
/** Many-image API limit: no dimension may exceed 2000px. */
const MAX_DIMENSION_PX = 2000;
const COMPRESSION_QUALITIES = [85, 60, 40];

function getExtension(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return "";
  return filePath.slice(dot).toLowerCase();
}

function isImageFile(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(getExtension(filePath));
}

function formatMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}


// ── Image compression (via ImageMagick) ────────────────────────────

async function compressImage(
  filePath: string,
  originalBase64Size: number,
): Promise<{ base64: string; mediaType: string; compressedBytes: number } | { error: string }> {
  const { tmpdir } = await import("os");
  const tmpOut = `${tmpdir()}/exocortex-compress-${Date.now()}.jpg`;

  try {
    for (const quality of COMPRESSION_QUALITIES) {
      const proc = Bun.spawn(
        ["magick", filePath, "-resize", `${MAX_DIMENSION_PX}x${MAX_DIMENSION_PX}>`, "-quality", quality.toString(), tmpOut],
        { stdout: "pipe", stderr: "pipe" },
      );
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        log("warn", `compressImage: magick exit ${exitCode}: ${stderr.slice(0, 200)}`);
        continue;
      }

      const compressedFile = Bun.file(tmpOut);
      if (!await compressedFile.exists()) continue;

      const compressedBytes = await compressedFile.arrayBuffer();
      const base64 = Buffer.from(compressedBytes).toString("base64");

      if (base64.length <= MAX_BASE64_BYTES) {
        return { base64, mediaType: "image/jpeg", compressedBytes: compressedBytes.byteLength };
      }
      log("debug", `compressImage: quality ${quality} → ${formatMB(base64.length)} MB base64, still over limit`);
    }

    return {
      error: `Error: image is ${formatMB(originalBase64Size)} MB (base64) which exceeds the Claude API limit of ${formatMB(MAX_BASE64_BYTES)} MB. Tried compressing with ImageMagick but still over the limit.`,
    };
  } finally {
    try { const { unlink } = await import("fs/promises"); await unlink(tmpOut).catch(() => {}); } catch { /* best-effort temp file cleanup */ }
  }
}

// ── Image file reading ─────────────────────────────────────────────

/** Use ImageMagick `identify` to get image dimensions. Returns null on failure. */
async function getImageDimensions(filePath: string): Promise<{ width: number; height: number } | null> {
  try {
    const proc = Bun.spawn(
      ["magick", "identify", "-format", "%w %h", filePath],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    // For animated images, identify may output multiple frames — take the first line
    const firstLine = stdout.trim().split("\n")[0];
    const [w, h] = firstLine.split(" ").map(Number);
    if (Number.isFinite(w) && Number.isFinite(h)) return { width: w, height: h };
    return null;
  } catch {
    return null;
  }
}

async function readImageFile(filePath: string): Promise<ToolResult> {
  try {
    const file = Bun.file(filePath);
    if (!await file.exists()) return { output: `Error: file not found: ${filePath}`, isError: true };

    const rawBytes = await file.arrayBuffer();
    const sizeBytes = rawBytes.byteLength;
    const base64 = Buffer.from(rawBytes).toString("base64");
    const ext = getExtension(filePath);

    const mediaType = SUPPORTED_MEDIA_TYPES[ext];

    // Check if we need compression: either too large in bytes, unsupported
    // format, or any dimension exceeds the many-image API limit (2000px).
    const dims = await getImageDimensions(filePath);
    const oversized = dims != null && (dims.width > MAX_DIMENSION_PX || dims.height > MAX_DIMENSION_PX);

    if (base64.length <= MAX_BASE64_BYTES && mediaType && !oversized) {
      return {
        output: `Read image: ${filePath} (${formatMB(sizeBytes)} MB${dims ? `, ${dims.width}×${dims.height}` : ""})`,
        isError: false,
        image: { mediaType, base64 },
      };
    }

    // Need compression / resize
    const reason = oversized
      ? `dimensions ${dims!.width}×${dims!.height} exceed ${MAX_DIMENSION_PX}px limit`
      : `base64 size ${formatMB(base64.length)} MB`;
    log("info", `readImageFile: ${filePath} needs compression (${reason}, format: ${ext})`);
    const result = await compressImage(filePath, base64.length);

    if ("error" in result) {
      return { output: result.error, isError: true };
    }

    const compressionNote = oversized
      ? `, resized from ${dims!.width}×${dims!.height}`
      : `, compressed from ${formatMB(sizeBytes)} MB`;
    return {
      output: `Read image: ${filePath} (${formatMB(result.compressedBytes)} MB${compressionNote})`,
      isError: false,
      image: { mediaType: result.mediaType, base64: result.base64 },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `readImageFile: ${filePath}: ${msg}`);
    return { output: `Error reading image ${filePath}: ${msg}`, isError: true };
  }
}

// ── Text file reading ──────────────────────────────────────────────

async function readTextFile(
  filePath: string,
  offset: number,
  limit: number,
): Promise<ToolResult> {
  try {
    const file = Bun.file(filePath);
    if (!await file.exists()) return { output: `Error: file not found: ${filePath}`, isError: true };

    const raw = await file.text();
    const allLines = raw.split("\n");
    // Remove trailing empty line from final newline
    if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop();

    const totalLines = allLines.length;
    const startIdx = Math.max(0, offset - 1); // offset is 1-based
    const endIdx = Math.min(totalLines, startIdx + limit);
    const slice = allLines.slice(startIdx, endIdx);

    // Format cat -n style: right-aligned line numbers + tab + content
    const maxNumWidth = String(endIdx).length;
    const formatted = slice.map((line, i) => {
      const lineNum = String(startIdx + i + 1).padStart(maxNumWidth);
      const truncated = line.length > MAX_LINE_CHARS ? safeSlice(line, MAX_LINE_CHARS) + "..." : line;
      return `${lineNum}\t${truncated}`;
    });

    let content = formatted.join("\n");
    if (endIdx < totalLines) {
      content += `\n... (${totalLines - endIdx} lines truncated)`;
    }
    return { output: cap(content), isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `readFile: ${filePath}: ${msg}`);
    return { output: `Error reading ${filePath}: ${msg}`, isError: true };
  }
}

// ── Execution entry point ──────────────────────────────────────────

async function executeRead(input: Record<string, unknown>): Promise<ToolResult> {
  const filePath = getString(input, "file_path");
  if (!filePath) return { output: "Error: missing 'file_path' parameter", isError: true };

  if (isImageFile(filePath)) {
    return readImageFile(filePath);
  }

  const offset = getNumber(input, "offset") ?? 1;
  const limit = getNumber(input, "limit") ?? DEFAULT_LINE_LIMIT;
  return readTextFile(filePath, offset, limit);
}

// ── Summary ────────────────────────────────────────────────────────

function summarize(input: Record<string, unknown>): ToolSummary {
  const filePath = getString(input, "file_path") ?? "";
  return { label: "Read", detail: summarizeParams(filePath, input, ["file_path"]) };
}

// ── Tool definition ────────────────────────────────────────────────

export const read: Tool = {
  name: "read",
  description: "Read a file from the local filesystem. Returns file content with line numbers (cat -n format). By default reads up to 2000 lines. Lines longer than 2000 characters are truncated. For image files (PNG, JPEG, GIF, WebP, BMP, TIFF, SVG, AVIF, ICO), returns the image for visual inspection; large images are automatically compressed to fit API limits.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file to read" },
      offset: { type: "number", description: "Line number to start reading from (1-based). Defaults to 1." },
      limit: { type: "number", description: "Maximum number of lines to read. Defaults to 2000." },
    },
    required: ["file_path"],
  },
  systemHint: "Prefer the read tool over cat/head/tail for reading files.",
  display: {
    label: "Read",
    color: "#82aaff",  // soft blue
  },
  summarize,
  execute: executeRead,
};
