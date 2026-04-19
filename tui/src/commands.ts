import type { RenderState } from "./state";
import { CONVO_COMMAND } from "./commands/convo";
import { EFFORT_COMMAND } from "./commands/effort";
import { FAST_COMMAND } from "./commands/fast";
import { createHelpCommand } from "./commands/help";
import { INSTRUCTIONS_COMMAND } from "./commands/instructions";
import { LOGIN_COMMAND } from "./commands/login";
import { LOGOUT_COMMAND } from "./commands/logout";
import { MODEL_COMMAND } from "./commands/model";
import { NEW_COMMAND } from "./commands/new";
import { QUIT_COMMAND, EXIT_COMMAND } from "./commands/quit";
import { RENAME_COMMAND } from "./commands/rename";
import { REPLAY_COMMAND } from "./commands/replay";
import { SYSTEM_COMMAND } from "./commands/system";
import { THEME_COMMAND } from "./commands/theme";
import { TIME_COMMAND } from "./commands/time";
import { TOKENS_COMMAND } from "./commands/tokens";
import { TRIM_COMMAND } from "./commands/trim";
import type { CommandResult, CompletionItem, SlashCommand } from "./commands/types";

const HELP_COMMAND = createHelpCommand(() => commands);

const commands: SlashCommand[] = [
  HELP_COMMAND,
  QUIT_COMMAND,
  EXIT_COMMAND,
  NEW_COMMAND,
  REPLAY_COMMAND,
  RENAME_COMMAND,
  MODEL_COMMAND,
  TRIM_COMMAND,
  EFFORT_COMMAND,
  FAST_COMMAND,
  CONVO_COMMAND,
  TOKENS_COMMAND,
  TIME_COMMAND,
  THEME_COMMAND,
  INSTRUCTIONS_COMMAND,
  SYSTEM_COMMAND,
  LOGIN_COMMAND,
  LOGOUT_COMMAND,
];

export function tryCommand(text: string, state: RenderState): CommandResult | null {
  if (!text.startsWith("/")) return null;

  const name = text.split(/\s+/)[0];
  const cmd = commands.find((command) => command.name === name);
  if (!cmd) return null;

  return cmd.handler(text, state);
}

export const COMMAND_LIST: CompletionItem[] = commands
  .filter((command) => command.name !== "/exit")
  .map((command) => ({ name: command.name, desc: command.description }));

export function getCommandArgs(state: RenderState): Record<string, CompletionItem[]> {
  const registry: Record<string, CompletionItem[]> = {};
  for (const command of commands) {
    if (command.args && command.args.length > 0) {
      registry[command.name] = command.args;
    }
    if (command.getArgs) {
      Object.assign(registry, command.getArgs(state));
    }
  }
  return registry;
}

export type { CommandResult, CompletionItem, SlashCommand } from "./commands/types";
