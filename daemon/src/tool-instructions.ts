/**
 * What the model is told about each tool, for /instructions tools.
 *
 * Built from the same pieces the request surface uses (tool selection, tool
 * schemas, system hints, Claude Code's MCP server instructions, external
 * manifests), so the view shows exactly what a turn on that provider gets.
 */

import { join } from "path";
import { repoRoot } from "@exocortex/shared/paths";
import type { ToolInstructionsEntry } from "@exocortex/shared/protocol";
import type { ModelId, ProviderId } from "./messages";
import { getConversationToolNames, getToolDefs, getToolSystemHintEntries } from "./tools/registry";
import { getExternalToolHintEntries } from "./external-tools";
import { hostToolDefs, hostToolInstructions } from "./providers/anthropic/host-tools";
import { getModelInfo } from "./providers/registry";

/** The source file of each built-in tool, under daemon/src/tools/. */
const INTERNAL_TOOL_SOURCES: Record<string, string> = {
  bash: "bash.ts",
  read: "read.ts",
  write: "write.ts",
  glob: "glob.ts",
  grep: "grep.ts",
  edit: "edit.ts",
  patch: "patch.ts",
  browse: "browse.ts",
  exec_command: "unified-exec.ts",
  write_stdin: "unified-exec.ts",
  apply_patch: "codex-files.ts",
  view_image: "codex-files.ts",
  exo: "exo.ts",
  chrono: "chrono.ts",
  goal: "goal.ts",
  client_bash: "client-bash.ts",
  remote_bash: "remote-bash.ts",
  attach: "attach.ts",
};

export function internalToolSource(name: string): string {
  const file = INTERNAL_TOOL_SOURCES[name];
  return file ? join(repoRoot(), "daemon", "src", "tools", file) : join(repoRoot(), "daemon", "src", "tools", "registry.ts");
}

const HOST_TOOLS_SOURCE = () => join(repoRoot(), "daemon", "src", "providers", "anthropic", "host-tools.ts");

export interface ToolInstructions {
  route: string;
  internal: ToolInstructionsEntry[];
  external: ToolInstructionsEntry[];
}

/** Tool text for a turn on `provider`/`model` (see buildConversationRequestSurface). */
export function describeToolInstructions(provider: ProviderId, model: ModelId | null, conversationId?: string): ToolInstructions {
  const chatOnly = model ? getModelInfo(provider, model)?.supportsTools === false : false;
  if (chatOnly) {
    return { route: "This model takes no tools: none are offered or described.", internal: [], external: [] };
  }
  const toolNames = getConversationToolNames(provider);
  const defs = getToolDefs(toolNames, conversationId, provider);
  const external = getExternalToolHintEntries().map(entry => ({ name: entry.name, source: entry.manifestPath, hint: entry.hint }));

  if (provider === "anthropic") {
    // Claude Code brings its own tools; Exocortex's reach it as an MCP server.
    const internal = hostToolDefs(defs).map((def): ToolInstructionsEntry => {
      const hint = hostToolInstructions(def.name);
      return {
        name: def.name,
        source: internalToolSource(def.name),
        description: def.description,
        ...(hint ? { hint, hintSource: HOST_TOOLS_SOURCE() } : {}),
      };
    });
    return {
      route: "Claude Code: its own tools and prompt; Exocortex tools as the exocortex MCP server (descriptions and server instructions); external tools appended to the system prompt.",
      internal,
      external,
    };
  }

  const hints = new Map(getToolSystemHintEntries(toolNames, conversationId).map(entry => [entry.name, entry.hint]));
  const internal = defs.map((def): ToolInstructionsEntry => {
    const hint = hints.get(def.name);
    return { name: def.name, source: internalToolSource(def.name), description: def.description, ...(hint ? { hint } : {}) };
  });
  return {
    route: "Exocortex system prompt: tool schemas carry the descriptions; hints go under # Internal tools and # External tools.",
    internal,
    external,
  };
}
