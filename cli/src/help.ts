/**
 * Help text for the CLI.
 *
 * Extracted from main.ts to keep the entry point focused on
 * arg parsing and dispatch logic.
 */

const b = (s: string) => `\x1b[1m${s}\x1b[0m`;

export function printHelp(): void {
  process.stdout.write(`${b("exo")} — Exocortex CLI client

${b("USAGE")}
  exo "message"                     Send a message (new conversation)
  exo "message" -c <id>             Continue a conversation
  exo "message" --opus              Use a specific model
  cat file | exo -                  Read message from stdin

${b("COMMANDS")}
  ls (list)                         List conversations
  info (show) <id>                  Conversation metadata
  history (log) <id>                Conversation history
  rm (delete, del) <id>             Delete a conversation
  abort (kill, cancel) <id>         Abort in-flight stream
  rename (mv, title) <id> <title>   Rename a conversation
  llm "text" --system "prompt"      One-shot LLM (no conversation)
  status (ping)                     Check if daemon is running
  help                              Show this help

${b("FLAGS")}
  --opus, --sonnet, --haiku         Model selection
  -c, --conv <id>                   Conversation ID
  --json                            Structured JSON output
  --full                            Include thinking + tool results
  --stream                          Stream events as NDJSON
  --id                              Print only conversation ID
  --timeout <sec>                   Max wait time (default 300)
  --system <prompt>                 System prompt (for llm)

Run ${b("exo <command> --help")} for command-specific usage.
`);
}

const COMMAND_HELP: Record<string, string> = {
  send: `${b("exo")} "message" [flags]

Send a message to the AI. Creates a new conversation unless -c is given.

${b("USAGE")}
  exo "what is 2+2"                 New conversation, default model
  exo "explain this" --opus         New conversation, specific model
  exo "follow up" -c <id>           Continue existing conversation
  cat prompt.txt | exo -            Read message from stdin
  echo "question" | exo - -c <id>   Stdin + continue conversation

${b("FLAGS")}
  -c, --conv <id>                   Continue this conversation
  --opus, --sonnet, --haiku         Model selection
  --json                            Output as JSON (blocks, tokens, duration)
  --full                            Include thinking blocks and tool results
  --stream                          Stream events as NDJSON as they arrive
  --id                              Print only the conversation ID
  --timeout <sec>                   Max wait time (default 300)

${b("OUTPUT")}
  Default: response text + tool call summaries, then "exo:<convId>" on the last line.
  Thinking blocks and tool result output are hidden unless --full is given.
`,

  ls: `${b("exo ls")} [flags]

List all conversations.

${b("FLAGS")}
  --json                            Output as JSON array

${b("OUTPUT")}
  Default: table with ID, model, message count, title, last updated.
  Pinned conversations show 📌, marked conversations show ★.
`,

  info: `${b("exo info")} <id> [flags]

Show metadata for a conversation.

${b("USAGE")}
  exo info <convId>
  exo info <convId> --json

${b("FLAGS")}
  --json                            Output as JSON object

${b("OUTPUT")}
  Conversation ID, model, message count, context token count, queued messages.
`,

  history: `${b("exo history")} <id> [flags]

Show the full message history of a conversation.

${b("USAGE")}
  exo history <convId>
  exo history <convId> --full
  exo history <convId> --json

${b("FLAGS")}
  --json                            Output as JSON array of display entries
  --full                            Include thinking blocks and tool results

${b("OUTPUT")}
  Default: user and assistant messages with role labels.
  Tool calls shown as summaries. Thinking and tool results hidden unless --full.
`,

  rm: `${b("exo rm")} <id>

Delete a conversation. The daemon soft-deletes to trash.

${b("USAGE")}
  exo rm <convId>
`,

  abort: `${b("exo abort")} <id>

Abort an in-flight stream for a conversation.

${b("USAGE")}
  exo abort <convId>
`,

  rename: `${b("exo rename")} <id> <title>

Rename a conversation.

${b("USAGE")}
  exo rename <convId> "new title"
`,

  status: `${b("exo status")} [flags]

Check if the daemon is running and show a quick summary.

${b("USAGE")}
  exo status
  exo status --json

${b("FLAGS")}
  --json                            Output as JSON object

${b("OUTPUT")}
  Daemon latency, conversation count, active streams.
  Exit code 2 if daemon is not running.
`,

  llm: `${b("exo llm")} "text" [flags]

One-shot LLM completion. No conversation is created or persisted.
Useful for quick utility calls (classification, summarization, etc).

${b("USAGE")}
  exo llm "summarize this text"
  exo llm "translate to spanish" --system "You are a translator"
  cat file.txt | exo llm - --system "Summarize" --haiku

${b("FLAGS")}
  --system <prompt>                 System prompt (default: "You are a helpful assistant.")
  --opus, --sonnet, --haiku         Model selection
  --json                            Output as JSON object
  --timeout <sec>                   Max wait time (default 300)
`,
};

// Resolve aliases for help lookups
const HELP_ALIASES: Record<string, string> = {
  list: "ls",
  delete: "rm",
  remove: "rm",
  del: "rm",
  kill: "abort",
  cancel: "abort",
  mv: "rename",
  title: "rename",
  ping: "status",
  health: "status",
  log: "history",
  show: "info",
  send: "send",
  chat: "send",
  ask: "send",
  one: "llm",
};

function resolveHelp(command: string): string {
  return HELP_ALIASES[command] ?? command;
}

export function printCommandHelp(command: string): void {
  const resolved = resolveHelp(command);
  const help = COMMAND_HELP[resolved];
  if (help) {
    process.stdout.write(help);
  } else {
    process.stderr.write(`No help available for '${command}'.\n`);
  }
}

export function hasCommandHelp(command: string): boolean {
  const resolved = resolveHelp(command);
  return resolved in COMMAND_HELP;
}
