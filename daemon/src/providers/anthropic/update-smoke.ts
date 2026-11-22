// End-to-end check of a Claude Code binary before scripts/claude-code-update.sh
// switches Exocortex to it: one real turn through the Agent SDK, with the
// daemon's own process options, an SDK MCP tool, a hook and streamed events.
//
//   CLAUDE_CODE_BIN=/path/to/claude bun run src/providers/anthropic/update-smoke.ts
//
// Exit 0: the binary works. Exit 3: inconclusive (every account at a usage
// limit). Anything else: the binary failed; the reason is on stderr.
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listClaudeAccounts } from "./accounts";
import { claudeProcessOptions, getClaudeBinary } from "./cli";

const TURN_TIMEOUT_MS = 120_000;
const LIMIT_TEXT = /usage limit|rate limit|limit reached|out of extra usage|hit your limit/i;

type Outcome = { ok: true } | { ok: false; limited: boolean; reason: string };

async function tryAccount(account: string, cwd: string): Promise<Outcome> {
  const nonce = `pong-${Math.random().toString(36).slice(2, 10)}`;
  let toolCalls = 0;
  let hookCalls = 0;
  let streamEvents = 0;
  let resultText = "";
  let error = "";
  const server = createSdkMcpServer({
    name: "smoke",
    version: "1.0.0",
    tools: [tool("ping", "Returns the word to reply with.", {}, async () => {
      toolCalls += 1;
      return { content: [{ type: "text", text: nonce }] };
    })],
  });
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), TURN_TIMEOUT_MS);
  try {
    for await (const message of query({
      prompt: "Call the ping tool once, then reply with exactly the text it returned and nothing else.",
      options: {
        ...claudeProcessOptions(cwd, account),
        model: "haiku",
        maxTurns: 4,
        tools: [],
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: { smoke: server },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        persistSession: false,
        hooks: { PreToolUse: [{ hooks: [async () => { hookCalls += 1; return {}; }] }] },
        abortController,
        stderr: data => { error += data; },
      },
    })) {
      if (message.type === "stream_event") streamEvents += 1;
      if (message.type === "result") {
        if (message.subtype === "success" && !message.is_error) resultText = message.result;
        else error += ` result ${message.subtype}: ${"result" in message ? message.result : ""} ${"errors" in message ? JSON.stringify(message.errors) : ""}`;
      }
    }
  } catch (cause) {
    error += ` ${cause instanceof Error ? cause.message : String(cause)}`;
  } finally {
    clearTimeout(timer);
  }
  const problems = [
    toolCalls === 0 && "the MCP tool was never called",
    hookCalls === 0 && "the PreToolUse hook never ran",
    streamEvents === 0 && "no partial stream events",
    !resultText.includes(nonce) && `the reply ${JSON.stringify(resultText.slice(0, 200))} lacks the tool's text`,
  ].filter(Boolean);
  if (problems.length === 0) return { ok: true };
  const reason = `${problems.join("; ")}${error.trim() ? ` (${error.trim().slice(-800)})` : ""}`;
  return { ok: false, limited: LIMIT_TEXT.test(error), reason };
}

const cwd = mkdtempSync(join(tmpdir(), "claude-update-smoke-"));
let exitCode = 1;
try {
  console.log(`checking ${getClaudeBinary()}`);
  const failures: string[] = [];
  let allLimited = true;
  for (const { id } of listClaudeAccounts()) {
    const outcome = await tryAccount(id, cwd);
    if (outcome.ok) {
      console.log(`ok on account ${id}`);
      exitCode = 0;
      break;
    }
    failures.push(`${id}: ${outcome.reason}`);
    if (!outcome.limited) {
      allLimited = false;
      break;
    }
  }
  if (exitCode !== 0) {
    exitCode = allLimited ? 3 : 1;
    console.error(failures.join("\n"));
  }
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
process.exit(exitCode);
