import type { SlashCommand } from "./types";

export const QUIT_COMMAND: SlashCommand = {
  name: "/quit",
  description: "Exit Exocortex",
  handler: () => ({ type: "quit" }),
};

export const EXIT_COMMAND: SlashCommand = {
  name: "/exit",
  description: "Exit Exocortex",
  handler: () => ({ type: "quit" }),
};
