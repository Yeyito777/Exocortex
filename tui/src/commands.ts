import type { RenderState } from "./state";
import { ACCOUNT_COMMAND } from "./commands/account";
import { BTW_COMMAND } from "./commands/btw";
import { COMPACT_COMMAND } from "./commands/compact";
import { CONVO_COMMAND } from "./commands/convo";
import { DEFAULT_MODEL_COMMAND } from "./commands/default-model";
import { EFFORT_COMMAND } from "./commands/effort";
import { FAST_COMMAND } from "./commands/fast";
import { GOAL_COMMAND } from "./commands/goal";
import { createHelpCommand } from "./commands/help";
import { HIDE_COMMAND } from "./commands/hide";
import { INSTRUCTIONS_COMMAND } from "./commands/instructions";
import { LOGIN_COMMAND } from "./commands/login";
import { LOGOUT_COMMAND } from "./commands/logout";
import { MODEL_COMMAND } from "./commands/model";
import { NEW_COMMAND } from "./commands/new";
import { PING_COMMAND } from "./commands/ping";
import { QUEUE_COMMAND } from "./commands/queue";
import { QUIT_COMMAND, EXIT_COMMAND } from "./commands/quit";
import { RENAME_COMMAND } from "./commands/rename";
import { REPLAY_COMMAND } from "./commands/replay";
import { SYSTEM_COMMAND } from "./commands/system";
import { THEME_COMMAND } from "./commands/theme";
import { TIME_COMMAND } from "./commands/time";
import { TOKENS_COMMAND } from "./commands/tokens";
import { TRIM_COMMAND } from "./commands/trim";
import { USAGE_COMMAND } from "./commands/usage";
import type { CommandResult, CompletionItem, SlashCommand } from "./commands/types";

const HELP_COMMAND = createHelpCommand(() => commands);

const commands: SlashCommand[] = [
  HELP_COMMAND,
  QUIT_COMMAND,
  EXIT_COMMAND,
  NEW_COMMAND,
  ACCOUNT_COMMAND,
  REPLAY_COMMAND,
  BTW_COMMAND,
  COMPACT_COMMAND,
  RENAME_COMMAND,
  MODEL_COMMAND,
  DEFAULT_MODEL_COMMAND,
  TRIM_COMMAND,
  EFFORT_COMMAND,
  FAST_COMMAND,
  QUEUE_COMMAND,
  GOAL_COMMAND,
  CONVO_COMMAND,
  TOKENS_COMMAND,
  USAGE_COMMAND,
  TIME_COMMAND,
  THEME_COMMAND,
  HIDE_COMMAND,
  PING_COMMAND,
  INSTRUCTIONS_COMMAND,
  SYSTEM_COMMAND,
  LOGIN_COMMAND,
  LOGOUT_COMMAND,
];

function isStandaloneOptionalArgCommand(text: string, commandName: string): boolean {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  return parts.length >= 1 && parts.length <= 2 && parts[0] === commandName;
}

function isStandaloneNoArgCommand(text: string, commandName: string): boolean {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  return parts.length === 1 && parts[0] === commandName;
}

export function tryCommand(text: string, state: RenderState): CommandResult | null {
  if (!text.startsWith("/")) return null;

  const name = text.split(/\s+/)[0];
  const cmd = commands.find((command) => command.name === name);
  if (!cmd) return null;
  if ((cmd === EFFORT_COMMAND || cmd === FAST_COMMAND) && !isStandaloneOptionalArgCommand(text, cmd.name)) return null;
  if (cmd === QUEUE_COMMAND && !isStandaloneNoArgCommand(text, cmd.name)) return null;

  return cmd.handler(text, state);
}

export const COMMAND_LIST: CompletionItem[] = commands
  .filter((command) => command.name !== "/exit")
  .map((command) => ({ name: command.name, desc: command.description }));

export function getCommandArgs(state: RenderState, commandName?: string): Record<string, CompletionItem[]> {
  const registry: Record<string, CompletionItem[]> = {};
  const candidates = commandName ? commands.filter((command) => command.name === commandName) : commands;
  for (const command of candidates) {
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
