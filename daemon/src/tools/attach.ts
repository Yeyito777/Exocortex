/**
 * attach — show local image files to the user at the end of the current
 * assistant message.
 *
 * Images are copied into daemon-managed, content-addressed storage (see
 * attachments.ts), so history keeps showing them after the source file
 * changes or disappears. The model receives a text receipt only: it chose or
 * rendered the image, and can Read it if it needs to look.
 */

import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import type { Tool } from "./types";
import type { ImageRef } from "../messages";
import { storeImageFile } from "../attachments";

export const MAX_ATTACH_IMAGES = 8;

function resolvePath(path: string, cwd: string | undefined): string {
  if (path === "~" || path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(cwd ?? process.cwd(), path);
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function describe(ref: ImageRef): string {
  return `${ref.name ?? ref.id.slice(0, 12)} (${ref.width}×${ref.height} ${ref.mediaType.slice(6).toUpperCase()}, ${formatSize(ref.sizeBytes)})`;
}

function pathsFromInput(input: Record<string, unknown>): string[] | string {
  const raw = input.paths;
  if (!Array.isArray(raw) || raw.length === 0) return "paths must be a non-empty array of image file paths.";
  if (raw.length > MAX_ATTACH_IMAGES) return `At most ${MAX_ATTACH_IMAGES} images can be attached per call.`;
  if (raw.some(path => typeof path !== "string" || !path.trim())) return "Every path must be a non-empty string.";
  return raw.map(path => (path as string).trim());
}

export const attach: Tool = {
  name: "attach",
  description: `Show local image files (PNG, JPEG, GIF, WebP; e.g. a chart you rendered, a screenshot, generated art) to the user, inline at the end of your current message. Up to ${MAX_ATTACH_IMAGES} per call. The images are copied when attached, so later edits to the files do not change what the user sees.`,
  inputSchema: {
    type: "object",
    properties: {
      paths: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: MAX_ATTACH_IMAGES,
        description: "Image file paths on this machine; relative paths resolve against the working directory.",
      },
    },
    required: ["paths"],
    additionalProperties: false,
  },
  display: { label: "Attach", color: "#f78c6c" },
  parallelSafety: "safe",
  defaultTimeoutMs: 60_000,
  summarize(input) {
    const paths = Array.isArray(input.paths) ? input.paths.filter((path): path is string => typeof path === "string") : [];
    return { label: "Attach", detail: paths.map(path => basename(path)).join(", ") };
  },
  async execute(input, context, signal) {
    const paths = pathsFromInput(input);
    if (typeof paths === "string") return { output: paths, isError: true };

    const attachments: ImageRef[] = [];
    const failures: string[] = [];
    for (const path of paths) {
      if (signal?.aborted) return { output: "Attach interrupted; nothing was attached.", isError: true };
      const resolved = resolvePath(path, context?.cwd);
      try {
        attachments.push(await storeImageFile(resolved));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        const reason = code === "ENOENT" ? "file not found"
          : code === "EACCES" ? "permission denied"
          : code === "EISDIR" ? "is a directory"
          : error instanceof Error ? error.message : String(error);
        failures.push(`${path}: ${reason}`);
      }
    }
    if (failures.length > 0) {
      return { output: `Nothing was attached.\n${failures.map(line => `- ${line}`).join("\n")}`, isError: true };
    }
    const noun = attachments.length === 1 ? "image" : "images";
    return {
      output: `Attached ${attachments.length} ${noun}; the user sees ${attachments.length === 1 ? "it" : "them"} after your message:\n${attachments.map(ref => `- ${describe(ref)}`).join("\n")}`,
      isError: false,
      attachments,
    };
  },
};
