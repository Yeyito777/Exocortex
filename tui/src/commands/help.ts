import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import type { SlashCommand } from "./types";

export function createHelpCommand(getCommands: () => readonly SlashCommand[]): SlashCommand {
  return {
    name: "/help",
    description: "Show available commands",
    handler: (_text, state) => {
      const lines = getCommands()
        .filter((command) => command.name !== "/exit")
        .map((command) => `${command.name}  ${command.description}`);
      pushSystemMessage(state, lines.join("\n"));
      clearPrompt(state);
      return { type: "handled" };
    },
  };
}
