import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import { getMarkPrefix } from "../marks";
import type { SlashCommand } from "./types";

export const RENAME_COMMAND: SlashCommand = {
  name: "/rename",
  description: "Rename the current conversation",
  handler: (text, state) => {
    if (!state.convId) {
      pushSystemMessage(state, "No active conversation to rename.");
      clearPrompt(state);
      return { type: "handled" };
    }
    const rawTitle = text.slice("/rename".length).trim();
    if (!rawTitle) {
      clearPrompt(state);
      return { type: "generate_title" };
    }
    const conv = state.sidebar.conversations.find((conversation) => conversation.id === state.convId);
    const markPrefix = conv ? getMarkPrefix(conv.title) : null;
    const title = markPrefix ? `${markPrefix} ${rawTitle}` : rawTitle;
    if (conv) conv.title = title;
    clearPrompt(state);
    return { type: "rename_conversation", title };
  },
};
