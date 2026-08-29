import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import { loadSshAliases } from "../ssh-aliases";
import type { SlashCommand } from "./types";

const USAGE = "Usage: /ssh [<ssh-alias>|cancel]";

export const SSH_COMMAND: SlashCommand = {
  name: "/ssh",
  description: "Route through an Exocortex daemon over SSH",
  getArgs: () => ({
    "/ssh": [
      ...loadSshAliases().map(alias => ({ name: alias, desc: "SSH alias" })),
      { name: "cancel", desc: "return to the local daemon" },
    ],
  }),
  handler: (text, state) => {
    const args = text.replace(/^\/ssh(?:\s+|$)/, "").trim().split(/\s+/).filter(Boolean);
    clearPrompt(state);
    if (args.length === 0) return { type: "ssh", action: "status" };
    if (args.length > 1) {
      pushSystemMessage(state, USAGE);
      return { type: "handled" };
    }
    if (args[0].toLowerCase() === "cancel") return { type: "ssh", action: "cancel" };
    return { type: "ssh", action: "connect", alias: args[0] };
  },
};
