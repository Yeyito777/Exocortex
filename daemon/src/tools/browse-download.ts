import { open, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

const TEXT_APPLICATION_TYPES = new Set([
  "application/ecmascript",
  "application/graphql",
  "application/javascript",
  "application/json",
  "application/sql",
  "application/toml",
  "application/x-httpd-php",
  "application/x-javascript",
  "application/x-ndjson",
  "application/x-www-form-urlencoded",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
]);

const BINARY_FILE_EXTENSIONS = new Set([
  ".7z", ".apk", ".avi", ".avif", ".bin", ".bmp", ".bz", ".bz2", ".class", ".deb",
  ".dmg", ".doc", ".docx", ".eot", ".epub", ".exe", ".flac", ".gif", ".gz", ".ico",
  ".iso", ".jar", ".jpeg", ".jpg", ".m4a", ".mkv", ".mov", ".mp3", ".mp4", ".mpeg",
  ".mpg", ".msi", ".odg", ".odp", ".ods", ".odt", ".ogg", ".otf", ".pdf", ".png",
  ".ppt", ".pptx", ".rar", ".rpm", ".tar", ".tif", ".tiff", ".ttf", ".wav", ".webm",
  ".webp", ".woff", ".woff2", ".xls", ".xlsx", ".xz", ".zip", ".zst",
]);

const CONTENT_TYPE_EXTENSIONS: Readonly<Record<string, string>> = {
  "application/epub+zip": ".epub",
  "application/gzip": ".gz",
  "application/java-archive": ".jar",
  "application/octet-stream": ".bin",
  "application/pdf": ".pdf",
  "application/vnd.android.package-archive": ".apk",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/wasm": ".wasm",
  "application/x-7z-compressed": ".7z",
  "application/x-rar-compressed": ".rar",
  "application/x-tar": ".tar",
  "application/zip": ".zip",
  "audio/flac": ".flac",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "font/otf": ".otf",
  "font/ttf": ".ttf",
  "font/woff": ".woff",
  "font/woff2": ".woff2",
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/svg+xml": ".svg",
  "image/tiff": ".tiff",
  "image/vnd.microsoft.icon": ".ico",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/mpeg": ".mpeg",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
};

export interface DownloadedFile {
  bytes: number;
  contentType: string;
  downloadPath: string;
  pageUrl: string;
}

export function normalizedContentType(headers: Headers): string {
  return (headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

function isAttachment(headers: Headers): boolean {
  const disposition = headers.get("content-disposition") ?? "";
  return /^\s*attachment(?:\s*;|\s*$)/i.test(disposition);
}

function isTextualContentType(contentType: string): boolean {
  if (!contentType) return true;
  if (contentType.startsWith("text/") || contentType.startsWith("message/")) return true;
  if (TEXT_APPLICATION_TYPES.has(contentType)) return true;
  if (contentType.startsWith("application/") && (contentType.endsWith("+json") || contentType.endsWith("+xml"))) {
    return true;
  }
  return false;
}

function urlHasBinaryExtension(pageUrl: string): boolean {
  try {
    return BINARY_FILE_EXTENSIONS.has(extname(new URL(pageUrl).pathname).toLowerCase());
  } catch {
    return false;
  }
}

export function shouldDownloadResponse(headers: Headers, pageUrl: string): boolean {
  if (isAttachment(headers)) return true;

  const contentType = normalizedContentType(headers);
  if (contentType) return !isTextualContentType(contentType);

  // A few CDNs omit Content-Type. Preserve browse's historical text fallback
  // unless the URL itself clearly names a common binary file format.
  return urlHasBinaryExtension(pageUrl);
}

function unquoteHeaderValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  return trimmed;
}

function decodeExtendedFilename(value: string): string | null {
  const unquoted = unquoteHeaderValue(value);
  const match = /^([^']*)'[^']*'(.*)$/.exec(unquoted);
  if (!match) return null;

  const charset = match[1]!.trim().toLowerCase();
  if (charset && charset !== "utf-8" && charset !== "us-ascii") return null;
  try {
    return decodeURIComponent(match[2]!);
  } catch {
    return null;
  }
}

function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;

  const extended = /(?:^|;)\s*filename\*\s*=\s*("(?:\\.|[^"])*"|[^;]*)/i.exec(header);
  if (extended) {
    const decoded = decodeExtendedFilename(extended[1]!);
    if (decoded) return decoded;
  }

  const regular = /(?:^|;)\s*filename\s*=\s*("(?:\\.|[^"])*"|[^;]*)/i.exec(header);
  if (!regular) return null;
  return unquoteHeaderValue(regular[1]!) || null;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;

  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function sanitizeDownloadFilename(value: string): string {
  let sanitized = value
    .replace(/[\\/<>:"|?*]/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "")
    .trim();
  if (!sanitized || sanitized === "." || sanitized === "..") sanitized = "download";
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(sanitized)) sanitized = `_${sanitized}`;

  const extension = extname(sanitized);
  if (Buffer.byteLength(sanitized, "utf8") > 200 && extension && extension !== sanitized) {
    const extensionBytes = Math.min(Buffer.byteLength(extension, "utf8"), 40);
    const stem = sanitized.slice(0, -extension.length);
    sanitized = truncateUtf8(stem, 200 - extensionBytes) + truncateUtf8(extension, extensionBytes);
  }
  return truncateUtf8(sanitized, 200) || "download";
}

function filenameFromUrl(pageUrl: string): string | null {
  try {
    const segment = new URL(pageUrl).pathname.split("/").pop();
    if (!segment) return null;
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  } catch {
    return null;
  }
}

function downloadFilename(headers: Headers, pageUrl: string): string {
  const contentType = normalizedContentType(headers);
  const suggested = filenameFromContentDisposition(headers.get("content-disposition"))
    ?? filenameFromUrl(pageUrl)
    ?? "download";
  let filename = sanitizeDownloadFilename(suggested);
  if (!extname(filename)) filename += CONTENT_TYPE_EXTENSIONS[contentType] ?? "";
  return sanitizeDownloadFilename(filename);
}

function numberedFilename(filename: string, number: number): string {
  if (number === 0) return filename;
  const extension = extname(filename);
  const stem = extension && extension !== filename ? filename.slice(0, -extension.length) : filename;
  return `${stem} (${number})${extension}`;
}

async function reserveDownloadFile(directory: string, filename: string): Promise<{ file: FileHandle; path: string }> {
  for (let number = 0; number < 10_000; number++) {
    const path = join(directory, numberedFilename(filename, number));
    try {
      return { file: await open(path, "wx"), path };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`could not choose an available filename for ${filename}`);
}

function declaredContentLength(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (!raw || !/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function assertDownloadSize(bytes: number): void {
  if (bytes > MAX_DOWNLOAD_BYTES) {
    throw new Error(`download exceeds the ${MAX_DOWNLOAD_BYTES / (1024 * 1024)} MiB browse limit`);
  }
}

export async function downloadResponse(
  response: Response,
  pageUrl: string,
  directory: string,
  signal?: AbortSignal,
): Promise<DownloadedFile> {
  const declaredBytes = declaredContentLength(response.headers);
  if (declaredBytes !== null && declaredBytes > MAX_DOWNLOAD_BYTES) {
    await response.body?.cancel().catch(() => {});
    assertDownloadSize(declaredBytes);
  }
  signal?.throwIfAborted();

  const filename = downloadFilename(response.headers, pageUrl);
  const reserved = await reserveDownloadFile(resolve(directory), filename);
  let bytes = 0;
  let completed = false;
  const reader = response.body?.getReader();
  const cancelRead = () => {
    void reader?.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", cancelRead, { once: true });

  try {
    if (reader) {
      while (true) {
        signal?.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;

        assertDownloadSize(bytes + next.value.byteLength);
        let offset = 0;
        while (offset < next.value.byteLength) {
          const written = await reserved.file.write(
            next.value,
            offset,
            next.value.byteLength - offset,
            bytes + offset,
          );
          if (written.bytesWritten <= 0) throw new Error(`could not write downloaded data to ${reserved.path}`);
          offset += written.bytesWritten;
        }
        bytes += next.value.byteLength;
      }
    }
    signal?.throwIfAborted();
    await reserved.file.close();
    completed = true;
  } finally {
    signal?.removeEventListener("abort", cancelRead);
    if (!completed) {
      await reader?.cancel().catch(() => {});
      await reserved.file.close().catch(() => {});
      await unlink(reserved.path).catch(() => {});
    }
  }

  return {
    bytes,
    contentType: normalizedContentType(response.headers),
    downloadPath: reserved.path,
    pageUrl,
  };
}
