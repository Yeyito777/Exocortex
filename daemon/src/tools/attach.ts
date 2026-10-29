/**
 * attach — show local image and video files to the user at the end of the
 * current assistant message.
 *
 * Files are copied into daemon-managed, content-addressed storage (see
 * attachments.ts and video-attachments.ts), so history keeps showing them
 * after the source file changes or disappears. A video is kept with a poster
 * frame the user can play in their terminal. The model receives a text
 * receipt only: it chose or rendered the file, and can Read an image if it
 * needs to look; it can't watch a video, so the receipt describes it.
 */

import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import type { Tool } from "./types";
import type { ImageRef } from "../messages";
import { storeAttachmentFile } from "../video-attachments";
import { describeVideo } from "@exocortex/shared/video";
import { toolTextSource } from "./tool-text";

export const MAX_ATTACH_IMAGES = 8;

function resolvePath(path: string, cwd: string | undefined): string {
  if (path === "~" || path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(cwd ?? process.cwd(), path);
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function describe(ref: ImageRef): string {
  if (ref.video) return `${ref.name ?? ref.video.id.slice(0, 12)} (video: ${describeVideo(ref.video)})`;
  return `${ref.name ?? ref.id.slice(0, 12)} (${ref.width}×${ref.height} ${ref.mediaType.slice(6).toUpperCase()}, ${formatSize(ref.sizeBytes)})`;
}

/** "1 image", "2 videos", "1 image and 1 video". */
function countNoun(attachments: readonly ImageRef[]): string {
  const videos = attachments.filter(ref => ref.video).length;
  const images = attachments.length - videos;
  const part = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  return [images ? part(images, "image") : "", videos ? part(videos, "video") : ""].filter(Boolean).join(" and ");
}

function pathsFromInput(input: Record<string, unknown>): string[] | string {
  const raw = input.paths;
  if (!Array.isArray(raw) || raw.length === 0) return "paths must be a non-empty array of image or video file paths.";
  if (raw.length > MAX_ATTACH_IMAGES) return `At most ${MAX_ATTACH_IMAGES} files can be attached per call.`;
  if (raw.some(path => typeof path !== "string" || !path.trim())) return "Every path must be a non-empty string.";
  return raw.map(path => (path as string).trim());
}

const TEXT = toolTextSource("attach", () => ({ maxImages: String(MAX_ATTACH_IMAGES) }));

export const attach: Tool = {
  name: "attach",
  get description() { return TEXT.description(); },
  get systemHint() { return TEXT.hint(); },
  inputSchema: {
    type: "object",
    properties: {
      paths: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: MAX_ATTACH_IMAGES,
        description: "Image or video file paths on this machine; relative paths resolve against the working directory.",
      },
    },
    required: ["paths"],
    additionalProperties: false,
  },
  display: { label: "Attach", color: "#f78c6c" },
  parallelSafety: "safe",
  // Copying, probing and a poster frame for a large video take a while.
  defaultTimeoutMs: 180_000,
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
        attachments.push(await storeAttachmentFile(resolved));
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
    const videos = attachments.some(ref => ref.video)
      ? `\nA video shows as its poster frame, which the user can play in their terminal; you can't watch it.`
      : "";
    return {
      output: `Attached ${countNoun(attachments)}; the user sees ${attachments.length === 1 ? "it" : "them"} after your message:\n${attachments.map(ref => `- ${describe(ref)}`).join("\n")}${videos}`,
      isError: false,
      attachments,
    };
  },
};
