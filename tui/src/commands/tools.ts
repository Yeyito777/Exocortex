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

interface AvailableToolRef {
  kind: "internal" | "external";
  name: string;
  label: string;
  category: "Internal" | "External" | "Custom";
}

/** Keep tool kinds available to policy mutations without exposing them in command text. */
function availableToolRefs(state: CommandState): AvailableToolRef[] {
  return [
    ...state.toolRegistry
      .map((tool) => ({ kind: "internal" as const, name: tool.name, label: tool.label, category: "Internal" as const })),
    ...(state.activeToolPolicy?.internal ?? [])
      .filter((tool) => tool.modulePath && !state.toolRegistry.some((registered) => registered.name === tool.name))
      .map((tool) => ({ kind: "internal" as const, name: tool.name, label: tool.label, category: "Custom" as const })),
    ...state.externalToolStyles
      .map((tool) => ({ kind: "external" as const, name: tool.cmd, label: tool.label, category: "External" as const })),
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
      const matches = available.filter((tool) => tool.name === value);
      if (matches.length > 0) {
        // A shared display name represents every matching implementation. This
        // keeps the command UX unified even if an internal and external tool
        // happen to use the same name.
        for (const match of matches) {
          if (!refs.some((ref) => ref.kind === match.kind && ref.name === match.name)) {
            refs.push({ kind: match.kind, name: match.name });
          }
        }
      } else {
        modulePaths.push(value);
      }
    }
  }
  return { tools: refs, modulePaths };
}

export function formatToolPolicySnapshot(snapshot: ToolPolicySnapshot, changed: boolean): string {
  const availability = new Map<string, boolean>();
  for (const entry of [...snapshot.internal, ...snapshot.external]) {
    availability.set(entry.name, (availability.get(entry.name) ?? false) || entry.enabled);
  }
  const list = (enabled: boolean) => {
    const names = [...availability]
      .filter(([, isEnabled]) => isEnabled === enabled)
      .map(([name]) => name);
    return names.length > 0 ? names.join(", ") : "(none)";
  };
  return [
    changed ? "Tool policy updated." : "Tool policy",
    `Mode: ${snapshot.source}${snapshot.scoped ? " · scoped subagent" : ""}`,
    "",
    `Enabled: ${list(true)}`,
    `Disabled: ${list(false)}`,
    ...((snapshot.modules?.length ?? 0) > 0
      ? [
          "",
          "Custom modules:",
          ...snapshot.modules!.map((module) => `  ${module.path} → ${module.tools.join(", ")}`),
          "",
          "Warning: custom tool modules are trusted code executed inside the daemon, not a sandbox.",
        ]
      : []),
    ...(snapshot.shellWarning ? ["", "Warning: bash or command-capable scheduling is enabled. Filesystem and external-command restrictions are not a hard sandbox while unrestricted process execution is available."] : []),
    "",
    "Use /tools enable, /tools disable, or /tools reset to change the next turn.",
  ].join("\n");
}

export const TOOLS_COMMAND: SlashCommand = {
  name: "/tools",
  description: "Show or change this conversation's tool availability",
  args: ACTIONS,
  getArgs: (state) => {
    const grouped = new Map<string, AvailableToolRef[]>();
    for (const tool of availableToolRefs(state)) {
      grouped.set(tool.name, [...(grouped.get(tool.name) ?? []), tool]);
    }
    const refs: CompletionItem[] = [...grouped].map(([name, tools]) => ({
      name,
      desc: `${[...new Set(tools.map((tool) => tool.category))].join(" / ")} · ${[...new Set(tools.map((tool) => tool.label))].join(" / ")}`,
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
