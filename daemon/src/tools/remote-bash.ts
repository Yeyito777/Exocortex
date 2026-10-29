/**
 * remote_bash tool — run a command on the machine a conversation's provider is
 * proxied through (/proxy, see docs/provider-proxy.md).
 *
 * The counterpart of client_bash: client_bash reaches the machine the user's
 * TUI runs on, remote_bash the machine whose provider login this conversation
 * borrows. It is offered only while the conversation's provider is proxied
 * (registry.ts), runs over the same SSH link as the model requests, as the
 * remote daemon's user, and fails clearly while that link is down. Subagents
 * get it like their parents. A call may name a /proxy machine by alias (host);
 * it must while remote_bash reaches several, and may leave it out only for the
 * one machine the conversation was told about.
 */

import type { Tool, ToolResult } from "./types";
import { getNumber, getString, summarizeParams } from "./util";
import { formatCommandOutput } from "./bash";
import * as convStore from "../conversations";
import { announcedHost, REMOTE_HOST_NOTICE_KIND } from "../messages";
import { activeProviderProxyManager } from "../provider-proxy/manager";
import { describeRemoteHost } from "../provider-proxy/link";
import { toolTextSource } from "./tool-text";

const DEFAULT_TIMEOUT_SECONDS = 600;
// {{proxyAlias}} names the /proxy machine ("alias, ") when the conversation's provider has one.
const TEXT = toolTextSource("remote_bash", provider => {
  const alias = provider ? activeProviderProxyManager()?.aliasFor(provider) : null;
  return { proxyAlias: alias ? `${alias}, ` : "" };
});

export const remoteBash: Tool = {
  name: "remote_bash",
  get description() { return TEXT.description(); },
  get systemHint() { return TEXT.hint(); },
  describe(provider) {
    return TEXT.description(provider);
  },
  hintFor: provider => TEXT.hint(provider),
  parallelSafety: "exclusive",
  defaultTimeoutMs: null,
  watchdogExempt: true,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to execute on the proxy's machine" },
      cwd: { type: "string", description: "Working directory there (default: the SSH user's home directory)" },
      timeout_seconds: { type: "number", description: `Timeout in seconds (default ${DEFAULT_TIMEOUT_SECONDS})` },
      host: { type: "string", description: "Alias of the /proxy machine to run on. Required while several are set up." },
    },
    required: ["command"],
    additionalProperties: false,
  },
  display: { label: "Remote $", color: "#c678dd" },
  summarize(input) {
    const host = getString(input, "host")?.trim();
    return { label: host ? `Remote ${host} $` : "Remote $", detail: summarizeParams(getString(input, "command") ?? "", input, ["command", "host"]) };
  },
  async execute(input, context, signal): Promise<ToolResult> {
    const command = getString(input, "command");
    if (!command) return { output: "Error: missing 'command' parameter", isError: true };
    const timeoutSeconds = getNumber(input, "timeout_seconds") ?? DEFAULT_TIMEOUT_SECONDS;
    if (!(timeoutSeconds > 0)) return { output: "Error: 'timeout_seconds' must be greater than 0 seconds", isError: true };
    const conv = context?.conversationId ? convStore.get(context.conversationId) : undefined;
    const provider = context?.provider ?? conv?.provider;
    const manager = activeProviderProxyManager();
    const own = manager?.aliasFor(provider);
    if (!manager || !own || !manager.linkFor(provider)) {
      return { output: "Error: remote_bash works only while this conversation's provider goes through /proxy.", isError: true };
    }
    const machines = manager.remoteExecAliases();
    const requested = getString(input, "host")?.trim();
    let alias: string;
    if (requested) {
      const match = machines.find(machine => machine === requested) ?? machines.find(machine => machine.toLowerCase() === requested.toLowerCase());
      if (!match) {
        return { output: `Error: No /proxy machine is called "${requested}"; remote_bash reaches ${machines.join(", ") || "none"}. Nothing was run.`, isError: true };
      }
      alias = match;
    } else if (machines.length > 1) {
      return { output: `Error: remote_bash reaches several /proxy machines: ${machines.join(", ")}. Nothing was run; pass host with the alias of the one the command is for.`, isError: true };
    } else if (announcedHost(conv?.messages ?? [], REMOTE_HOST_NOTICE_KIND) !== own) {
      return { output: `Error: Nothing was run: host is needed, as this conversation was not told remote_bash runs on ${own}. Pass host="${own}" only if the command is meant for that machine.`, isError: true };
    } else {
      alias = own;
    }
    const link = manager.linkForAlias(alias);
    if (!link) return { output: `Error: remote_bash cannot reach ${alias} right now.`, isError: true };

    const cwd = getString(input, "cwd");
    const outcome = await link.exec({ command, ...(cwd ? { cwd } : {}), timeoutMs: Math.round(timeoutSeconds * 1000) }, signal);
    if ("failure" in outcome) return { output: `Error: ${outcome.failure}`, isError: true };

    const where = `${alias} (${describeRemoteHost(outcome.host, alias)})`;
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
