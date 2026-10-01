import { isRealUserMessage, type Conversation, type StoredMessage } from "./messages";

export const MAX_TITLE_CONTEXT_CHARS = 2000;
const archivedContext = new WeakMap<Conversation, string[]>();

export function titleUserText(content: StoredMessage["content"]): string {
  if (typeof content === "string") return content.trim();
  const text = content.filter(block => block.type === "text")
    .map(block => (block as { text: string }).text).filter(text => text.trim()).join("\n").trim();
  return text || (content.some(block => block.type === "image") ? "[image]" : "");
}

export function setArchivedTitleContext(conv: Conversation, text: string[]): void {
  archivedContext.set(conv, text);
}

/** Earliest user context, not the most recent compacted tail. */
export function titleContext(conv: Conversation, extraContext?: string): string {
  const parts: string[] = [];
  let remaining = MAX_TITLE_CONTEXT_CHARS;
  const add = (text: string) => {
    if (!text || remaining <= 0) return;
    parts.push(text.slice(0, remaining));
    remaining -= text.length;
  };
  add(extraContext?.trim() ?? "");
  for (const text of archivedContext.get(conv) ?? []) add(text);
  for (const message of conv.messages) {
    if (remaining <= 0) break;
    if (isRealUserMessage(message)) add(titleUserText(message.content));
  }
  return parts.join("\n\n");
}
