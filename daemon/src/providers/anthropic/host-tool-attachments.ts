import type { ImageRef } from "../../messages";

/**
 * Images attach calls produced, by Claude Code tool_use id, until the stream
 * records the matching tool_result (see stream.ts). Claude Code only relays
 * the text result back, so the refs travel beside it in-process.
 */
const pendingAttachments = new Map<string, ImageRef[]>();
const MAX_PENDING_ATTACHMENT_CALLS = 256;

export function takeHostToolAttachments(toolUseId: string): ImageRef[] | undefined {
  const images = pendingAttachments.get(toolUseId);
  pendingAttachments.delete(toolUseId);
  return images;
}

export function rememberHostToolAttachments(toolUseId: string, images: ImageRef[]): void {
  pendingAttachments.set(toolUseId, images);
  // Results that never reach a stream (aborted turns) must not accumulate.
  while (pendingAttachments.size > MAX_PENDING_ATTACHMENT_CALLS) {
    pendingAttachments.delete(pendingAttachments.keys().next().value!);
  }
}
