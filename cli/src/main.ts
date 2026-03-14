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
 *   exo status                      Check daemon health
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
import { send, ls, info, history, rm, abort, rename, llm, status, type OutputOptions } from "./commands";
import { printHelp, printCommandHelp, hasCommandHelp } from "./help";
import type { ModelId } from "@exocortex/shared/protocol";

// ── Arg parsing ─────────────────────────────────────────────────────

const SUBCOMMANDS = new Set(["ls", "info", "history", "rm", "abort", "rename", "llm", "status", "help"]);

// Aliases → canonical subcommand name
const ALIASES: Record<string, string> = {
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
  send: "send",        // explicit send (not a real subcommand, handled in default)
  chat: "send",
  ask: "send",
  one: "llm",          // "exo one 'quick question'" as shorthand for llm
};

// Words that look like they could be command attempts (for the safety heuristic)
function looksLikeCommand(word: string): boolean {
  // Single lowercase word, no spaces, short enough to be a command, not a path/URL
  return /^[a-z][-a-z0-9]{1,15}$/.test(word)
    && !word.includes("/")
    && !word.includes(".")
    && !word.startsWith("http");
}

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

  // Detect subcommand: first positional if it's a known command or alias
  if (result.positionals.length > 0) {
    const first = result.positionals[0];
    if (SUBCOMMANDS.has(first)) {
      result.subcommand = result.positionals.shift()!;
    } else if (first in ALIASES) {
      result.positionals.shift();
      const resolved = ALIASES[first];
      // "send", "chat", "ask" resolve to "send" which is the default path (null subcommand)
      result.subcommand = resolved === "send" ? null : resolved;
    }
  }

  return result;
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
    if (topic && hasCommandHelp(topic)) {
      printCommandHelp(topic);
    } else {
      printHelp();
    }
    return 0;
  }

  // --help flag on a subcommand: exo ls --help
  if (args.wantsHelp) {
    if (args.subcommand && hasCommandHelp(args.subcommand)) {
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

      case "status":
        return await status(conn, opts);

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

        // Safety heuristic: if ALL positionals are short lowercase words,
        // they probably meant a command, not a message to send to the AI.
        if (args.positionals.length <= 3 && args.positionals.every(w => looksLikeCommand(w)) && !args.conv) {
          const allCommands = [...SUBCOMMANDS].filter(c => c !== "help").concat(Object.keys(ALIASES));
          process.stderr.write(
            `Unknown command: ${text}\n` +
            `Available commands: ${[...SUBCOMMANDS].filter(c => c !== "help").join(", ")}\n` +
            `Aliases: ${Object.entries(ALIASES).map(([a, c]) => `${a}→${c}`).join(", ")}\n\n` +
            `If you meant to send this as a message, quote it:\n` +
            `  exo "${text}"\n`
          );
          return 1;
        }

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
