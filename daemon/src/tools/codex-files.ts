import type { Tool } from "./types";
import { resolve } from "path";
import { patch, executePatch } from "./patch";
import { read, readImageFile } from "./read";
import { APPLY_PATCH_GRAMMAR } from "./provider-primitives";
import { toolTextSource } from "./tool-text";

const APPLY_PATCH_TEXT = toolTextSource("apply_patch");

export const applyPatch: Tool = {
  ...patch,
  name: "apply_patch",
  get description() { return APPLY_PATCH_TEXT.description(); },
  freeform: { type: "grammar", syntax: "lark", definition: APPLY_PATCH_GRAMMAR },
  summarize: input => ({ label: "Patch", detail: typeof input.input === "string"
    ? [...input.input.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(match => match[1]).join(", ") : "" }),
  inputSchema: {
    type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false,
  },
  get systemHint() { return APPLY_PATCH_TEXT.hint(); },
  execute: (input, context, signal) => executePatch({ input: input.input }, context, signal, true),
};

const VIEW_IMAGE_TEXT = toolTextSource("view_image");

export const viewImage: Tool = {
  ...read,
  name: "view_image",
  display: { label: "Image", color: read.display.color },
  get description() { return VIEW_IMAGE_TEXT.description(); },
  inputSchema: {
    type: "object", properties: { path: { type: "string", description: "Local filesystem path to an image file." } }, required: ["path"], additionalProperties: false,
  },
  get systemHint() { return VIEW_IMAGE_TEXT.hint(); },
  summarize: input => ({ label: "Image", detail: String(input.path ?? "") }),
  execute: async (input, context, signal) => {
    if (typeof input.path !== "string" || !input.path || input.path.includes("\0")) {
      return { output: "view_image requires a local image path.", isError: true };
    }
    if (signal?.aborted) return { output: "Image loading aborted.", isError: true };
    return readImageFile(resolve(context?.cwd ?? process.cwd(), input.path));
  },
};
