import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import type { CompletionItem, SlashCommand } from "./types";

/** Where `/instructions <arg>` goes: an instruction scope's editor, or the tools view. */
export type InstructionsView = "conversation" | "folder" | "global" | "tools";

const VIEW_ARGS: ReadonlyArray<{ view: InstructionsView; desc: string; aliases: string[] }> = [
  { view: "conversation", desc: "Edit this conversation's instructions", aliases: ["convo", "c"] },
  { view: "folder", desc: "Edit this folder's instructions", aliases: ["f"] },
  { view: "global", desc: "Edit the instructions every conversation gets", aliases: ["g"] },
  { view: "tools", desc: "Read what the model is told about each tool", aliases: ["t"] },
];

const ARGS: CompletionItem[] = [
  ...VIEW_ARGS.map(arg => ({ name: arg.view, desc: arg.desc, aliases: arg.aliases })),
  { name: "clear", desc: "Clear this conversation's instructions", exact: true },
];

/**
 * The view a `/instructions` argument names, or null when it is instructions
 * text. An argument counts only as the sole word, so "global rules apply" is
 * text; one-word instructions that spell an argument go through the editor.
 */
export function parseInstructionsView(arg: string): InstructionsView | null {
  const word = arg.trim().toLowerCase();
  if (!word || /\s/.test(word)) return null;
  return VIEW_ARGS.find(entry => entry.view === word || entry.aliases.includes(word))?.view ?? null;
}

export const INSTRUCTIONS_COMMAND: SlashCommand = {
  name: "/instructions",
  description: "View and edit conversation, folder or global instructions, or the tools'; with text, set this conversation's (g i)",
  args: ARGS,
  handler: (text, state) => {
    const trimmed = text.slice("/instructions".length).trim();
    clearPrompt(state);
    if (!trimmed) return { type: "open_instructions" };
    const view = parseInstructionsView(trimmed);
    if (view) return { type: "open_instructions", view };
    if (trimmed === "clear") {
      if (!state.convId) {
        pushSystemMessage(state, "This conversation has no instructions to clear yet.");
        return { type: "handled" };
      }
      pushSystemMessage(state, "Conversation instructions cleared.");
      return { type: "set_system_instructions", text: "" };
    }
    if (!state.convId) return { type: "create_conversation_for_instructions", text: trimmed };
    pushSystemMessage(state, "Conversation instructions set. /instructions shows them.");
    return { type: "set_system_instructions", text: trimmed };
  },
};
