import type { ToolPolicySnapshot } from "../protocol";
import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import type { CompletionItem, SlashCommand } from "./types";

const ACTIONS: CompletionItem[] = [
  { name: "enable", desc: "Enable tools or load a tool module" },
  { name: "disable", desc: "Disable tools or detach a tool module" },
  { name: "reset", desc: "Restore this conversation's default policy" },
];

type CommandState = Parameters<SlashCommand["handler"]>[1];

type ToolKind = "internal" | "external";

interface AvailableToolRef {
  kind: ToolKind;
  /** Canonical name sent to the daemon in a policy mutation. */
  policyName: string;
  /** Unambiguous name shown and accepted by /tools. */
  commandName: string;
  label: string;
  category: "Internal" | "External" | "Custom";
}

function toolCommandName(kind: ToolKind, policyName: string): string {
  if (policyName !== "exo") return policyName;
  return kind === "internal" ? "exocortex" : "exo-cli";
}

function availableToolRef(
  kind: ToolKind,
  policyName: string,
  label: string,
  category: AvailableToolRef["category"],
): AvailableToolRef {
  return { kind, policyName, commandName: toolCommandName(kind, policyName), label, category };
}

/** Keep canonical policy names available without exposing ambiguous names in command text. */
function availableToolRefs(state: CommandState): AvailableToolRef[] {
  return [
    ...state.toolRegistry
      .map((tool) => availableToolRef("internal", tool.name, tool.label, "Internal")),
    ...(state.activeToolPolicy?.internal ?? [])
      .filter((tool) => tool.modulePath && !state.toolRegistry.some((registered) => registered.name === tool.name))
      .map((tool) => availableToolRef("internal", tool.name, tool.label, "Custom")),
    ...state.externalToolStyles
      .map((tool) => availableToolRef("external", tool.cmd, tool.label, "External")),
  ];
}

function usage(state: Parameters<SlashCommand["handler"]>[1], detail?: string) {
  pushSystemMessage(state, [
    detail,
    "Usage:",
    "  /tools",
    "  /tools enable <name> ...",
    "  /tools enable path/to/tool.ts",
    "  /tools disable <name> ...",
    "  /tools disable path/to/tool.ts",
    "  /tools reset",
  ].filter(Boolean).join("\n"));
}

function parseTargets(values: string[], state: CommandState): {
  tools: Array<{ kind: "internal" | "external"; name: string }>;
  modulePaths: string[];
} | null {
  const refs: Array<{ kind: "internal" | "external"; name: string }> = [];
  const modulePaths: string[] = [];
  const available = availableToolRefs(state);
  for (const value of values) {
    const internal = value.startsWith("internal:");
    const external = value.startsWith("external:");
    if (internal || external) {
      const kind = internal ? "internal" : "external";
      const name = value.slice(kind.length + 1);
      if (!name) return null;
      refs.push({ kind, name });
    } else {
      const match = available.find((tool) => tool.commandName === value);
      if (match) {
        if (!refs.some((ref) => ref.kind === match.kind && ref.name === match.policyName)) {
          refs.push({ kind: match.kind, name: match.policyName });
        }
      } else if (available.some((tool) => tool.policyName === value && tool.commandName !== value)) {
        // Do not reinterpret an ambiguous canonical name such as `exo` as a
        // module path. Its internal and external implementations have distinct
        // command names (`exocortex` and `exo-cli`).
        return null;
      } else {
        modulePaths.push(value);
      }
    }
  }
  return { tools: refs, modulePaths };
}

export function formatToolPolicySnapshot(snapshot: ToolPolicySnapshot, changed: boolean): string {
  const list = (kind: ToolKind, entries: ToolPolicySnapshot["internal"], enabled: boolean) => {
    const names = entries
      .filter((entry) => entry.enabled === enabled)
      .map((entry) => toolCommandName(kind, entry.name));
    return names.length > 0 ? names.join(", ") : "(none)";
  };
  return [
    changed ? "Tool policy updated." : "Tool policy",
    `Mode: ${snapshot.source}${snapshot.scoped ? " · scoped subagent" : ""}`,
    "",
    "Enabled:",
    `  Internal: ${list("internal", snapshot.internal, true)}`,
    `  External: ${list("external", snapshot.external, true)}`,
    "",
    "Disabled:",
    `  Internal: ${list("internal", snapshot.internal, false)}`,
    `  External: ${list("external", snapshot.external, false)}`,
    ...((snapshot.modules?.length ?? 0) > 0
      ? [
          "",
          "Custom modules:",
          ...snapshot.modules!.map((module) => `  ${module.path} → ${module.tools.join(", ")}`),
          "",
          "Warning: custom tool modules are trusted code executed inside the daemon, not a sandbox.",
        ]
      : []),
  ].join("\n");
}

export const TOOLS_COMMAND: SlashCommand = {
  name: "/tools",
  description: "Show or change this conversation's tool availability",
  args: ACTIONS,
  getArgs: (state) => {
    const refs: CompletionItem[] = availableToolRefs(state).map((tool) => ({
      name: tool.commandName,
      desc: `${tool.category} · ${tool.label}`,
    }));
    const moduleRefs: CompletionItem[] = (state.activeToolPolicy?.modules ?? []).map((module) => ({
      name: module.path,
      insertText: module.path,
      desc: `Custom module · ${module.tools.join(", ")}`,
    }));
    return {
      "/tools enable": refs,
      "/tools disable": [...refs, ...moduleRefs],
    };
  },
  handler: (text, state) => {
    clearPrompt(state);
    const parts = text.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 1) return { type: "tool_policy" };
    const action = parts[1];
    if (action === "reset" && parts.length === 2) {
      return { type: "tool_policy", mutation: { action: "reset" } };
    }
    if ((action === "enable" || action === "disable") && parts.length >= 3) {
      const targets = parseTargets(parts.slice(2), state);
      if (targets) {
        return {
          type: "tool_policy",
          mutation: {
            action,
            tools: targets.tools,
            ...(targets.modulePaths.length > 0 ? { modulePaths: targets.modulePaths } : {}),
          },
        };
      }
    }
    usage(state, "Invalid /tools command.");
    return { type: "handled" };
  },
};
