import type { ToolPolicySnapshot } from "../protocol";
import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import type { CompletionItem, SlashCommand } from "./types";

const ACTIONS: CompletionItem[] = [
  { name: "enable", desc: "Enable tools or load a tool module" },
  { name: "disable", desc: "Disable tools or detach a tool module" },
  { name: "reset", desc: "Restore this conversation's default policy" },
];

function usage(state: Parameters<SlashCommand["handler"]>[1], detail?: string) {
  pushSystemMessage(state, [
    detail,
    "Usage:",
    "  /tools",
    "  /tools enable internal:<name> external:<name> ...",
    "  /tools enable path/to/tool.ts",
    "  /tools disable internal:<name> external:<name> ...",
    "  /tools disable path/to/tool.ts",
    "  /tools reset",
  ].filter(Boolean).join("\n"));
}

function parseTargets(values: string[]): {
  tools: Array<{ kind: "internal" | "external"; name: string }>;
  modulePaths: string[];
} | null {
  const refs: Array<{ kind: "internal" | "external"; name: string }> = [];
  const modulePaths: string[] = [];
  for (const value of values) {
    const internal = value.startsWith("internal:");
    const external = value.startsWith("external:");
    if (internal || external) {
      const kind = internal ? "internal" : "external";
      const name = value.slice(kind.length + 1);
      if (!name) return null;
      refs.push({ kind, name });
    } else {
      modulePaths.push(value);
    }
  }
  return { tools: refs, modulePaths };
}

export function formatToolPolicySnapshot(snapshot: ToolPolicySnapshot, changed: boolean): string {
  const list = (entries: ToolPolicySnapshot["internal"], enabled: boolean) => {
    const names = entries.filter((entry) => entry.enabled === enabled).map((entry) => entry.name);
    return names.length > 0 ? names.join(", ") : "(none)";
  };
  return [
    changed ? "Tool policy updated." : "Tool policy",
    `Mode: ${snapshot.source}${snapshot.scoped ? " · scoped subagent" : ""}`,
    "",
    `Internal enabled: ${list(snapshot.internal, true)}`,
    `Internal disabled: ${list(snapshot.internal, false)}`,
    `External enabled: ${list(snapshot.external, true)}`,
    `External disabled: ${list(snapshot.external, false)}`,
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
    const refs: CompletionItem[] = [
      ...state.toolRegistry
        .map((tool) => ({ name: tool.name, insertText: `internal:${tool.name}`, desc: `Internal · ${tool.label}` })),
      ...(state.activeToolPolicy?.internal ?? [])
        .filter((tool) => tool.modulePath && !state.toolRegistry.some((registered) => registered.name === tool.name))
        .map((tool) => ({ name: tool.name, insertText: `internal:${tool.name}`, desc: `Custom · ${tool.label}` })),
      ...state.externalToolStyles.map((tool) => ({ name: tool.cmd, insertText: `external:${tool.cmd}`, desc: `External · ${tool.label}` })),
    ];
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
      const targets = parseTargets(parts.slice(2));
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
