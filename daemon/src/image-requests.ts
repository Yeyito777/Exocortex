/**
 * Resolve the bytes behind a client's get_image request.
 *
 * Model-attached images are in the managed store. User-pasted images live in
 * the conversation itself (as provider image blocks); the first preview of one
 * copies it into the store, so later requests skip the conversation scan.
 */

import * as convStore from "./conversations";
import { findStoredImage, imageIdForBytes, putImageBytes, sniffImage } from "./attachments";
import type { ImageMediaType, StoredMessage } from "./messages";
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
  if (found) putImageBytes(found.bytes, found.mediaType);
  return found;
}
