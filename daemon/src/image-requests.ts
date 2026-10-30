/**
 * Resolve the bytes behind a client's get_image request.
 *
 * Model-attached images are in the managed store. User-pasted images live in
 * the conversation itself (as provider image blocks); the first preview of one
 * copies it into the store, so later requests skip the conversation scan.
 * Images a client sends are also copied into the store on arrival: the turn
 * stores its user message only after loading the conversation, and a client's
 * first preview of its own paste would otherwise race it. An ephemeral app
 * conversation's images stay in memory only: never copied into the store.
 */

import * as convStore from "./conversations";
import { isEphemeralConversation } from "./app-registry";
import { findStoredImage, imageIdForBytes, putImageBytes, sniffImage } from "./attachments";
import type { ImageAttachment, ImageMediaType, StoredMessage } from "./messages";
import { log } from "./log";
import { readFileSync } from "node:fs";

export interface ImageSource {
  bytes: Buffer;
  mediaType: ImageMediaType;
}

function findInMessages(messages: readonly StoredMessage[], imageId: string): ImageSource | null {
  for (const message of messages) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== "image" || !block.source.data) continue;
      const bytes = Buffer.from(block.source.data, "base64");
      if (imageIdForBytes(bytes) !== imageId) continue;
      const sniffed = sniffImage(bytes);
      if (!sniffed) return null;
      return { bytes, mediaType: sniffed.mediaType };
    }
  }
  return null;
}

export async function resolveImageForPreview(imageId: string, convId?: string): Promise<ImageSource | null> {
  const stored = findStoredImage(imageId);
  if (stored) return { bytes: readFileSync(stored.path), mediaType: stored.mediaType };
  if (!convId) return null;

  let found = findInMessages((await convStore.getAsync(convId))?.messages ?? [], imageId);
  if (!found) {
    // Older messages may be outside the loaded archive window.
    try {
      found = findInMessages((await convStore.getFullAsync(convId))?.messages ?? [], imageId);
    } catch {
      return null;
    }
  }
  if (found && !isEphemeralConversation(convId)) putImageBytes(found.bytes, found.mediaType);
  return found;
}

/** Store the images of a message a client just sent to `convId` (sent or queued), so previews never wait on the turn. */
export function rememberSentImages(convId: string | undefined, images: readonly ImageAttachment[] | undefined): void {
  if (!images?.length || (convId !== undefined && isEphemeralConversation(convId))) return;
  for (const image of images) {
    if (!image.base64) continue;
    try {
      const bytes = Buffer.from(image.base64, "base64");
      const sniffed = sniffImage(bytes);
      if (sniffed) putImageBytes(bytes, sniffed.mediaType);
    } catch (error) {
      log("warn", `image-requests: could not store a sent image: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Pasted images larger than this travel in live events as their id and size
 * only. The sender already holds the bytes and other clients fetch a preview
 * sized to what they draw; echoing a multi-megabyte screenshot back would
 * hold up the turn's first tokens behind it on a slow link.
 */
export const ECHO_INLINE_IMAGE_CHARS = 128 * 1024;

/** A user message's images as a `user_message` event carries them. */
export function imagesForEcho(images: readonly ImageAttachment[] | undefined): ImageAttachment[] | undefined {
  return images?.map((image) => {
    if (image.base64.length <= ECHO_INLINE_IMAGE_CHARS) return image;
    let identity: Pick<ImageAttachment, "imageId" | "width" | "height"> = {};
    try {
      const bytes = Buffer.from(image.base64, "base64");
      const sniffed = sniffImage(bytes);
      identity = { imageId: image.imageId ?? imageIdForBytes(bytes), ...(sniffed ? { width: sniffed.width, height: sniffed.height } : {}) };
    } catch {
      return image;
    }
    return { mediaType: image.mediaType, base64: "", sizeBytes: image.sizeBytes, ...identity };
  });
}
