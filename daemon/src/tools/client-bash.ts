/**
 * client_bash tool — run a command on the user's own machine.
 *
 * The machine is reached through its Exocortex daemon's /proxy link to this
 * daemon, or a TUI it connected over /ssh (see client-hosts.ts); the command
 * runs there, not on this host. Subagents get it like their parents. The tool
 * is always offered so connecting and disconnecting never change the provider
 * tool list (and its prompt cache); availability is checked per call and
 * announced to the model with a notice in the conversation. A call names its
 * machine by client ID (host); it may leave it out only while the one machine
 * connected is the one that notice named (client-hosts.ts).
 */

import type { Tool, ToolResult } from "./types";
import { getNumber, getString, summarizeParams } from "./util";
import { formatCommandOutput } from "./bash";
import { describeClientHost, runOnClientHost } from "../client-hosts";
import * as convStore from "../conversations";
import { announcedHost, CLIENT_HOST_NOTICE_KIND } from "../messages";
import { toolTextSource } from "./tool-text";

const DEFAULT_TIMEOUT_SECONDS = 600;

const TEXT = toolTextSource("client_bash");

export const clientBash: Tool = {
  name: "client_bash",
  get description() { return TEXT.description(); },
  get systemHint() { return TEXT.hint(); },
  parallelSafety: "exclusive",
  defaultTimeoutMs: null,
  watchdogExempt: true,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to execute on the user's machine" },
      cwd: { type: "string", description: "Working directory on the user's machine (default: their home directory)" },
      timeout_seconds: { type: "number", description: `Timeout in seconds (default ${DEFAULT_TIMEOUT_SECONDS})` },
      host: { type: "string", description: "Client ID of the user's machine to run on, e.g. mac. Required while several are connected." },
    },
    required: ["command"],
    additionalProperties: false,
  },
  display: { label: "Client $", color: "#56b6c2" },
  summarize(input) {
    const host = getString(input, "host")?.trim();
    return { label: host ? `Client ${host} $` : "Client $", detail: summarizeParams(getString(input, "command") ?? "", input, ["command", "host"]) };
  },
  async execute(input, context, signal): Promise<ToolResult> {
    const command = getString(input, "command");
    if (!command) return { output: "Error: missing 'command' parameter", isError: true };
    const timeoutSeconds = getNumber(input, "timeout_seconds") ?? DEFAULT_TIMEOUT_SECONDS;
    if (!(timeoutSeconds > 0)) return { output: "Error: 'timeout_seconds' must be greater than 0 seconds", isError: true };

    const cwd = getString(input, "cwd");
    const host = getString(input, "host")?.trim() || undefined;
    const conv = context?.conversationId ? convStore.get(context.conversationId) : undefined;
    const outcome = await runOnClientHost({
      host,
      announced: conv ? announcedHost(conv.messages, CLIENT_HOST_NOTICE_KIND) : null,
    }, {
      command,
      ...(cwd ? { cwd } : {}),
      timeoutMs: Math.round(timeoutSeconds * 1000),
    }, signal);
    if ("failure" in outcome) return { output: `Error: ${outcome.failure}`, isError: true };

    const where = `${outcome.clientId} (${describeClientHost(outcome.host)})`;
    let output = formatCommandOutput(outcome.output, outcome.byteTruncated);
    if (outcome.timedOut) {
      output = `Error: command timed out after ${timeoutSeconds}s on ${where}${output ? `\n${output}` : ""}`;
    } else if (outcome.error) {
      output = `Error on ${where}: ${outcome.error}${output ? `\n${output}` : ""}`;
    }
    if (outcome.exitCode !== 0 && outcome.exitCode !== null) output += `\n(exit code ${outcome.exitCode})`;
    if (outcome.signal && !outcome.timedOut) output += `\n(terminated by signal ${outcome.signal})`;
    return {
      output,
      isError: outcome.timedOut || Boolean(outcome.error) || Boolean(outcome.signal)
        || (outcome.exitCode !== 0 && outcome.exitCode !== null),
      exitCode: outcome.exitCode,
    };
  },
};
