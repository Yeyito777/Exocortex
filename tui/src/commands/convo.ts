import { copyToClipboard } from "../vim/clipboard";
import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import { convDisplayName } from "../messages";
import { getMarkFromTitle } from "../marks";
import type { SlashCommand } from "./types";

function formatConvoInfo(state: Parameters<SlashCommand["handler"]>[1]): string | null {
  if (!state.convId) return null;

  const conv = state.sidebar.conversations.find((conversation) => conversation.id === state.convId);
  const title = conv ? convDisplayName(conv, "(untitled)") : "(untitled)";
  const provider = conv?.provider ?? state.provider;
  const model = conv?.model ?? state.model;
  const msgs = conv?.messageCount ?? state.messages.filter((message) => message.role !== "system" && message.role !== "system_instructions").length;
  const created = conv ? new Date(conv.createdAt).toLocaleString() : "unknown";
  const updated = conv ? new Date(conv.updatedAt).toLocaleString() : "unknown";
  const markLabel = conv ? getMarkFromTitle(conv.title)?.label ?? null : null;
  const flags = [
    conv?.pinned && "pinned",
    conv?.marked && "starred",
    conv?.fastMode && "fast",
    markLabel,
  ].filter(Boolean).join(", ");

  const lines = [
    `Title:    ${title}`,
    `ID:       ${state.convId}`,
    `Provider: ${provider}`,
    `Model:    ${model}`,
    `Effort:   ${state.effort}`,
    `Fast:     ${state.fastMode ? "on" : "off"}`,
    `Messages: ${msgs}`,
    `Created:  ${created}`,
    `Updated:  ${updated}`,
  ];
  if (flags) lines.push(`Flags:    ${flags}`);

  return lines.join("\n");
}

export const CONVO_COMMAND: SlashCommand = {
  name: "/convo",
  description: "Copy conversation info to clipboard",
  handler: (_text, state) => {
    if (!state.convId) {
      pushSystemMessage(state, "No active conversation.");
      clearPrompt(state);
      return { type: "handled" };
    }

    const info = formatConvoInfo(state);
    if (!info) {
      pushSystemMessage(state, "No active conversation.");
      clearPrompt(state);
      return { type: "handled" };
    }

    copyToClipboard(info);
    pushSystemMessage(state, "Conversation info copied to clipboard.");
    clearPrompt(state);
    return { type: "handled" };
  },
};
