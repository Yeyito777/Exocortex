/**
 * client_bash tool — run a command on the user's own machine.
 *
 * When the user's TUI is connected to this daemon over /ssh, the command runs
 * on the machine that TUI runs on (see client-hosts.ts), not on this host.
 * The tool is always offered so connecting and disconnecting never change the
 * provider tool list (and its prompt cache); availability is checked per call
 * and announced to the model with a notice in the conversation.
 */

import type { Tool, ToolResult } from "./types";
import { getNumber, getString, summarizeParams } from "./util";
import { formatCommandOutput } from "./bash";
import { describeClientHost, runOnClientHost } from "../client-hosts";
import * as convStore from "../conversations";
import { isScopedSubagent } from "../subagent-policy";

const DEFAULT_TIMEOUT_SECONDS = 600;

export const clientBash: Tool = {
  name: "client_bash",
  description: "Run a shell command on the machine the user is connected from over /ssh (such as their laptop), not on this host. "
    + "Uses bash (PowerShell on Windows) and returns stdout and stderr. Works only while the user's TUI is connected over /ssh. "
    + "Starts in the user's home directory unless cwd is set; a ~ prefix is expanded.",
  parallelSafety: "exclusive",
  defaultTimeoutMs: null,
  watchdogExempt: true,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to execute on the user's machine" },
      cwd: { type: "string", description: "Working directory on the user's machine (default: their home directory)" },
      timeout_seconds: { type: "number", description: `Timeout in seconds (default ${DEFAULT_TIMEOUT_SECONDS})` },
    },
    required: ["command"],
    additionalProperties: false,
  },
  display: { label: "Client $", color: "#56b6c2" },
  summarize(input) {
    return { label: "Client $", detail: summarizeParams(getString(input, "command") ?? "", input, ["command"]) };
  },
  async execute(input, context, signal): Promise<ToolResult> {
    const command = getString(input, "command");
    if (!command) return { output: "Error: missing 'command' parameter", isError: true };
    const timeoutSeconds = getNumber(input, "timeout_seconds") ?? DEFAULT_TIMEOUT_SECONDS;
    if (!(timeoutSeconds > 0)) return { output: "Error: 'timeout_seconds' must be greater than 0 seconds", isError: true };
    const conv = context?.conversationId ? convStore.get(context.conversationId) : undefined;
    if (conv && isScopedSubagent(conv)) return { output: "client_bash is not available to subagents.", isError: true };

    const cwd = getString(input, "cwd");
    const outcome = await runOnClientHost(context?.conversationId, {
      command,
      ...(cwd ? { cwd } : {}),
      timeoutMs: Math.round(timeoutSeconds * 1000),
    }, signal);
    if ("failure" in outcome) return { output: `Error: ${outcome.failure}`, isError: true };

    let output = formatCommandOutput(outcome.output, outcome.byteTruncated);
    if (outcome.timedOut) {
      output = `Error: command timed out after ${timeoutSeconds}s on ${describeClientHost(outcome.host)}${output ? `\n${output}` : ""}`;
    } else if (outcome.error) {
      output = `Error on ${describeClientHost(outcome.host)}: ${outcome.error}${output ? `\n${output}` : ""}`;
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
