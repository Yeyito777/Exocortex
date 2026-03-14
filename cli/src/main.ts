#!/usr/bin/env bun
/**
 * exo — Exocortex CLI client.
 *
 * A stateless, machine-friendly interface to exocortexd.
 * Each invocation connects, does its work, and disconnects.
 * The daemon holds all state; conversation IDs are the handles.
 *
 * Usage:
 *   exo "question"                  Send a message (new conversation)
 *   exo "follow up" -c <id>         Continue a conversation
 *   exo ls                          List conversations
 *   exo info <id>                   Show conversation metadata
 *   exo history <id>                Show conversation history
 *   exo rm <id>                     Delete a conversation
 *   exo abort <id>                  Abort in-flight stream
 *   exo rename <id> <title>         Rename a conversation
 *   exo llm "text" --system "..."   One-shot LLM completion
 *
 * Flags:
 *   --opus, --sonnet, --haiku       Model selection
 *   -c, --conv <id>                 Conversation ID
 *   --json                          JSON output
 *   --full                          Include thinking + tool results
 *   --stream                        Stream events as NDJSON
 *   --id                            Print only conversation ID
 *   --timeout <sec>                 Max wait time (default 300)
 *   --system <prompt>               System prompt (for llm command)
 */

import { Connection } from "./conn";
import { send, ls, info, history, rm, abort, rename, llm, type OutputOptions } from "./commands";
import type { ModelId } from "@exocortex/shared/protocol";

// ── Arg parsing ─────────────────────────────────────────────────────

const SUBCOMMANDS = new Set(["ls", "info", "history", "rm", "abort", "rename", "llm", "help"]);

interface ParsedArgs {
  subcommand: string | null;
  positionals: string[];
  conv: string | null;
  model: ModelId | null;
  system: string;
  json: boolean;
  full: boolean;
  stream: boolean;
  idOnly: boolean;
  timeout: number;
  wantsHelp: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    subcommand: null,
    positionals: [],
    conv: null,
    model: null,
    system: "You are a helpful assistant.",
    json: false,
    full: false,
    stream: false,
    idOnly: false,
    timeout: 300_000,
    wantsHelp: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    // Flags
    if (arg === "--opus") { result.model = "opus"; i++; continue; }
    if (arg === "--sonnet") { result.model = "sonnet"; i++; continue; }
    if (arg === "--haiku") { result.model = "haiku"; i++; continue; }
    if (arg === "--json") { result.json = true; i++; continue; }
    if (arg === "--full") { result.full = true; i++; continue; }
    if (arg === "--stream") { result.stream = true; i++; continue; }
    if (arg === "--id") { result.idOnly = true; i++; continue; }
    if ((arg === "-c" || arg === "--conv") && i + 1 < argv.length) {
      result.conv = argv[++i]; i++; continue;
    }
    if (arg === "--system" && i + 1 < argv.length) {
      result.system = argv[++i]; i++; continue;
    }
    if (arg === "--timeout" && i + 1 < argv.length) {
      result.timeout = parseInt(argv[++i], 10) * 1000; i++; continue;
    }
    if (arg === "-h" || arg === "--help") {
      result.wantsHelp = true; i++; continue;
    }

    // Positionals
    result.positionals.push(arg);
    i++;
  }

  // Detect subcommand: first positional if it's a known command
  if (result.positionals.length > 0 && SUBCOMMANDS.has(result.positionals[0])) {
    result.subcommand = result.positionals.shift()!;
  }

  return result;
}

// ── Help ────────────────────────────────────────────────────────────

const b = (s: string) => `\x1b[1m${s}\x1b[0m`;

function printHelp(): void {
  process.stdout.write(`${b("exo")} — Exocortex CLI client

${b("USAGE")}
  exo "message"                     Send a message (new conversation)
  exo "message" -c <id>             Continue a conversation
  exo "message" --opus              Use a specific model
  cat file | exo -                  Read message from stdin

${b("COMMANDS")}
  ls                                List conversations
  info <id>                         Conversation metadata
  history <id>                      Conversation history
  rm <id>                           Delete a conversation
  abort <id>                        Abort in-flight stream
  rename <id> <title>               Rename a conversation
  llm "text" --system "prompt"      One-shot LLM (no conversation)
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
  Default: table with ID (prefix), model, message count, title, last updated.
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

function printCommandHelp(command: string): void {
  const help = COMMAND_HELP[command];
  if (help) {
    process.stdout.write(help);
  } else {
    process.stderr.write(`No help available for '${command}'.\n`);
  }
}

// ── Stdin reading ───────────────────────────────────────────────────

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  // help subcommand: exo help <command>
  if (args.subcommand === "help") {
    const topic = args.positionals[0];
    if (topic && COMMAND_HELP[topic]) {
      printCommandHelp(topic);
    } else {
      printHelp();
    }
    return 0;
  }

  // --help flag on a subcommand: exo ls --help
  if (args.wantsHelp) {
    if (args.subcommand && COMMAND_HELP[args.subcommand]) {
      printCommandHelp(args.subcommand);
    } else if (!args.subcommand && args.positionals.length === 0) {
      printHelp();
    } else {
      // exo --help with positionals → treat as "send --help"
      printCommandHelp("send");
    }
    return 0;
  }

  // No args at all → show help
  if (args.positionals.length === 0 && !args.subcommand) {
    printHelp();
    return 0;
  }

  const opts: OutputOptions = {
    json: args.json,
    full: args.full,
    stream: args.stream,
    idOnly: args.idOnly,
    timeout: args.timeout,
  };

  const conn = new Connection();

  try {
    await conn.connect();
  } catch (err: any) {
    process.stderr.write(`Error: ${err.message}\n`);
    return 2;
  }

  try {
    switch (args.subcommand) {
      case "ls":
        return await ls(conn, opts);

      case "info": {
        const convId = args.positionals[0];
        if (!convId) { process.stderr.write("Usage: exo info <convId>\nRun 'exo info --help' for details.\n"); return 1; }
        return await info(conn, convId, opts);
      }

      case "history": {
        const convId = args.positionals[0];
        if (!convId) { process.stderr.write("Usage: exo history <convId>\nRun 'exo history --help' for details.\n"); return 1; }
        return await history(conn, convId, opts);
      }

      case "rm": {
        const convId = args.positionals[0];
        if (!convId) { process.stderr.write("Usage: exo rm <convId>\n"); return 1; }
        return await rm(conn, convId);
      }

      case "abort": {
        const convId = args.positionals[0];
        if (!convId) { process.stderr.write("Usage: exo abort <convId>\n"); return 1; }
        return await abort(conn, convId);
      }

      case "rename": {
        const convId = args.positionals[0];
        const title = args.positionals.slice(1).join(" ");
        if (!convId || !title) { process.stderr.write("Usage: exo rename <convId> <title>\nRun 'exo rename --help' for details.\n"); return 1; }
        return await rename(conn, convId, title);
      }

      case "llm": {
        const text = args.positionals[0] === "-"
          ? await readStdin()
          : args.positionals.join(" ");
        if (!text) { process.stderr.write("Usage: exo llm \"text\" --system \"prompt\"\nRun 'exo llm --help' for details.\n"); return 1; }
        return await llm(conn, text, args.system, args.model, opts);
      }

      default: {
        // No subcommand → send message
        let text: string;
        if (args.positionals.length === 1 && args.positionals[0] === "-") {
          text = await readStdin();
        } else {
          text = args.positionals.join(" ");
        }
        if (!text) { printHelp(); return 0; }
        return await send(conn, text, args.conv, args.model, opts);
      }
    }
  } catch (err: any) {
    process.stderr.write(`Error: ${err.message}\n`);
    return 1;
  } finally {
    conn.disconnect();
  }
}

main().then((code) => process.exit(code));
