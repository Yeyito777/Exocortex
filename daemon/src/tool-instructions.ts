/**
 * What the model is told about each tool, for /instructions tools.
 *
 * Built from the same pieces the request surface uses (tool selection, tool
 * schemas, hints, external manifests), so the view shows exactly what a turn
 * on that provider gets: each tool's description and hint, the same way on
 * every route. Each piece is a block naming the file it is stored in, which
 * save_tool_instructions (./tool-instructions-save) writes back.
 */

import { join } from "path";
import type { ToolInstructionsBlock, ToolInstructionsEntry } from "@exocortex/shared/protocol";
import { repoRoot } from "@exocortex/shared/paths";
import type { ModelId, ProviderId } from "./messages";
import { getConversationToolNames, getToolDefs } from "./tools/registry";
import { EXOCORTEX_SOURCE_DIR_PLACEHOLDER, getLoadedExternalTools } from "./external-tools";
import { hostToolDefs } from "./providers/anthropic/host-tools";
import { getModelInfo } from "./providers/registry";
import { readToolTextFile, toolTextPath, toolTextToken, toolTextValues, type ToolTextKind } from "./tools/tool-text";
import { expandTemplate, type TemplateToken } from "./tools/tool-text-template";

export interface ToolInstructions {
  route: string;
  internal: ToolInstructionsEntry[];
  external: ToolInstructionsEntry[];
}

/** Where a block is stored and how its text expands: what a save needs. */
export interface ToolTextTarget {
  id: string;
  tool: string;
  /** A built-in tool's text file, or an external tool's manifest (its systemHint). */
  store: { kind: "file"; textKind: ToolTextKind } | { kind: "manifest" };
  path: string;
  /** The text as stored, placeholders unexpanded. */
  template: string;
  /** Placeholders as written and what they expand to on this route. */
  tokens: TemplateToken[];
  /** The text as the model gets it. */
  text: string;
  /** False when an empty text is not allowed (a schema description). */
  allowEmpty: boolean;
}

const LABELS = {
  description: "Description",
  hint: "Hint",
} as const;

/** Where hints go on the route; descriptions are always the tool schemas'. */
const ROUTES = {
  claudeCode: "Claude Code runs its own tools; these reach it over MCP, with the hints as the server's instructions.",
  exocortex: "Hints go in the system prompt.",
} as const;

function internalTarget(tool: string, textKind: ToolTextKind, provider?: ProviderId): ToolTextTarget {
  const path = toolTextPath(tool, textKind);
  const template = readToolTextFile(path);
  const tokens = Object.entries(toolTextValues(tool, provider)).map(([name, value]): TemplateToken => [toolTextToken(name), value]);
  return {
    id: `internal:${tool}:${textKind}`,
    tool,
    store: { kind: "file", textKind },
    path,
    template,
    tokens,
    text: expandTemplate(template, tokens),
    allowEmpty: textKind !== "description",
  };
}

function externalTargets(): ToolTextTarget[] {
  const tokens: TemplateToken[] = [[EXOCORTEX_SOURCE_DIR_PLACEHOLDER, repoRoot()]];
  return getLoadedExternalTools().map(tool => ({
    id: `external:${tool.manifest.name}`,
    tool: tool.manifest.name,
    store: { kind: "manifest" },
    path: join(tool.toolDir, "manifest.json"),
    template: tool.manifest.systemHint,
    tokens,
    text: expandTemplate(tool.manifest.systemHint, tokens),
    allowEmpty: true,
  }));
}

function block(target: ToolTextTarget, label: string): ToolInstructionsBlock {
  return { id: target.id, label, text: target.text, source: target.path, editable: true };
}

/** Every block on the route, by id, with where it is stored. */
export function describeToolTextTargets(provider: ProviderId, model: ModelId | null, conversationId?: string): { view: ToolInstructions; targets: Map<string, ToolTextTarget> } {
  const targets = new Map<string, ToolTextTarget>();
  const add = (target: ToolTextTarget, label: string): ToolInstructionsBlock => {
    targets.set(target.id, target);
    return block(target, label);
  };

  const chatOnly = model ? getModelInfo(provider, model)?.supportsTools === false : false;
  if (chatOnly) {
    return { view: { route: "This model takes no tools: none are offered or described.", internal: [], external: [] }, targets };
  }

  const external = externalTargets().map((target): ToolInstructionsEntry => {
    const blocks = [add(target, LABELS.hint)];
    return { name: target.tool, source: target.path, ...(target.text ? { hint: target.text } : {}), blocks };
  });

  // Claude Code brings its own tools; only the host tools are Exocortex's.
  const claudeCode = provider === "anthropic";
  const defs = getToolDefs(getConversationToolNames(provider), conversationId, provider);
  const internal = (claudeCode ? hostToolDefs(defs) : defs).map((def): ToolInstructionsEntry => {
    const description = internalTarget(def.name, "description", provider);
    const hint = internalTarget(def.name, "hint", provider);
    return {
      name: def.name,
      source: description.path,
      description: description.text,
      ...(hint.text ? { hint: hint.text } : {}),
      hintSource: hint.path,
      blocks: [add(description, LABELS.description), add(hint, LABELS.hint)],
    };
  });
  return { view: { route: claudeCode ? ROUTES.claudeCode : ROUTES.exocortex, internal, external }, targets };
}

/** Tool text for a turn on `provider`/`model` (see buildConversationRequestSurface). */
export function describeToolInstructions(provider: ProviderId, model: ModelId | null, conversationId?: string): ToolInstructions {
  return describeToolTextTargets(provider, model, conversationId).view;
}
