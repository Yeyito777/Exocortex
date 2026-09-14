import type { Tool } from "./types";
import { resolve } from "path";
import { patch, executePatch } from "./patch";
import { read, readImageFile } from "./read";
import { APPLY_PATCH_GRAMMAR } from "./provider-primitives";

export const applyPatch: Tool = {
  ...patch,
  name: "apply_patch",
  description: "The apply_patch tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
  freeform: { type: "grammar", syntax: "lark", definition: APPLY_PATCH_GRAMMAR },
  summarize: input => ({ label: "Patch", detail: typeof input.input === "string"
    ? [...input.input.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(match => match[1]).join(", ") : "" }),
  inputSchema: {
    type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false,
  },
  systemHint: "Use apply_patch for file edits, creates, deletes, and renames. Supply raw patch text, not JSON or a shell command. Relative paths resolve from the conversation workspace; absolute file paths are also supported. Read and search files with exec_command (e.g. rg, cat, sed).",
  execute: (input, context, signal) => executePatch({ input: input.input }, context, signal, true),
};

export const viewImage: Tool = {
  ...read,
  name: "view_image",
  display: { label: "Image", color: read.display.color },
  description: "View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk.",
  inputSchema: {
    type: "object", properties: { path: { type: "string", description: "Local filesystem path to an image file." } }, required: ["path"], additionalProperties: false,
  },
  systemHint: "Use view_image for local images. Text files require exec_command when available in this session.",
  summarize: input => ({ label: "Image", detail: String(input.path ?? "") }),
  execute: async (input, context, signal) => {
    if (typeof input.path !== "string" || !input.path || input.path.includes("\0")) {
      return { output: "view_image requires a local image path.", isError: true };
    }
    if (signal?.aborted) return { output: "Image loading aborted.", isError: true };
    return readImageFile(resolve(context?.cwd ?? process.cwd(), input.path));
  },
};
