import type { ToolPolicySnapshot } from "../protocol";
import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import type { CompletionItem, SlashCommand } from "./types";

const ACTIONS: CompletionItem[] = [
  { name: "allow", desc: "Enable one or more internal:/external: tools" },
  { name: "deny", desc: "Disable one or more internal:/external: tools" },
  { name: "profile", desc: "Apply research, workspace, shell, or full" },
  { name: "reset", desc: "Restore this conversation's default policy" },
];

function usage(state: Parameters<SlashCommand["handler"]>[1], detail?: string) {
  pushSystemMessage(state, [
    detail,
    "Usage:",
    "  /tools",
    "  /tools allow internal:<name> external:<name> ...",
    "  /tools deny internal:<name> external:<name> ...",
    "  /tools profile research|workspace|shell|full",
    "  /tools reset",
  ].filter(Boolean).join("\n"));
}

function parseRefs(values: string[]): Array<{ kind: "internal" | "external"; name: string }> | null {
  const refs: Array<{ kind: "internal" | "external"; name: string }> = [];
  for (const value of values) {
    const separator = value.indexOf(":");
    const kind = value.slice(0, separator);
    const name = value.slice(separator + 1);
    if ((kind !== "internal" && kind !== "external") || separator <= 0 || !name) return null;
    refs.push({ kind, name });
  }
  return refs;
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
    ...(snapshot.shellWarning ? ["", "Warning: bash or command-capable scheduling is enabled. Filesystem and external-command restrictions are not a hard sandbox while unrestricted process execution is available."] : []),
    "",
    "Use /tools allow, /tools deny, /tools profile, or /tools reset to change the next turn.",
  ].join("\n");
}

export const TOOLS_COMMAND: SlashCommand = {
  name: "/tools",
  description: "Show or change this conversation's tool availability",
  args: ACTIONS,
  getArgs: (state) => {
    const refs: CompletionItem[] = [
      ...state.toolRegistry
        .filter((tool) => tool.name !== "external")
        .map((tool) => ({ name: `internal:${tool.name}`, desc: `Internal · ${tool.label}` })),
      ...state.externalToolStyles.map((tool) => ({ name: `external:${tool.cmd}`, desc: `External · ${tool.label}` })),
    ];
    return {
      "/tools allow": refs,
      "/tools deny": refs,
      "/tools profile": [
        { name: "research", desc: "Read/glob/grep/browse; no external tools" },
        { name: "workspace", desc: "Research plus write/edit/patch; no shell" },
        { name: "shell", desc: "All internal tools; no external tools" },
        { name: "full", desc: "All installed internal and external tools" },
      ],
    };
  },
  handler: (text, state) => {
    clearPrompt(state);
    if (!state.convId) {
      pushSystemMessage(state, "Start or open a conversation before using /tools.");
      return { type: "handled" };
    }
    const parts = text.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 1) return { type: "tool_policy" };
    const action = parts[1];
    if (action === "reset" && parts.length === 2) {
      return { type: "tool_policy", mutation: { action: "reset" } };
    }
    if (action === "profile" && parts.length === 3 && ["research", "workspace", "shell", "full"].includes(parts[2])) {
      return { type: "tool_policy", mutation: { action: "profile", profile: parts[2] as "research" | "workspace" | "shell" | "full" } };
    }
    if ((action === "allow" || action === "deny") && parts.length >= 3) {
      const tools = parseRefs(parts.slice(2));
      if (tools) return { type: "tool_policy", mutation: { action, tools } };
    }
    usage(state, "Invalid /tools command.");
    return { type: "handled" };
  },
};
