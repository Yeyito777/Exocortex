import type { ToolPolicyMutation, ToolPolicySnapshot } from "@exocortex/shared/messages";
import type { Conversation, ConversationToolPolicy } from "./messages";
import { getExternalToolNames, getExternalToolStyles } from "./external-tools";
import { getRegisteredTools } from "./tools/registry";

export const RESEARCH_INTERNAL_TOOLS = ["read", "glob", "grep", "browse"] as const;
export const LEGACY_EDIT_INTERNAL_TOOLS = ["bash", "write", "edit", "patch", "chrono"] as const;
const EXTERNAL_TOOL_TRANSPORT = "bash";

function uniqueNames(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function getConfigurableInternalToolNames(): string[] {
  return getRegisteredTools().map((tool) => tool.name);
}

export function getDefaultSubagentInternalToolNames(maxDepth: number | null, allowEdits: boolean): string[] {
  return [
    ...RESEARCH_INTERNAL_TOOLS,
    ...(allowEdits ? LEGACY_EDIT_INTERNAL_TOOLS : []),
    ...(typeof maxDepth === "number" && maxDepth > 0 ? ["exo"] : []),
  ];
}

export interface ResolvedToolPolicy {
  internalToolNames: string[];
  configurableInternalToolNames: string[];
  externalToolNames: string[];
  source: "default" | "explicit";
  scoped: boolean;
}

export function resolveConversationToolPolicy(
  conversation: Pick<Conversation, "subagentPolicy" | "subagentMaxDepth" | "toolPolicy">,
  maxDepth: number | null = conversation.subagentMaxDepth ?? null,
): ResolvedToolPolicy {
  const registeredInternal = getConfigurableInternalToolNames();
  const registeredInternalSet = new Set(registeredInternal);
  const installedExternal = getExternalToolNames();
  const installedExternalSet = new Set(installedExternal);
  const scoped = conversation.subagentPolicy != null;
  const selected = conversation.toolPolicy ?? null;

  const defaultInternal = scoped
    ? getDefaultSubagentInternalToolNames(maxDepth, conversation.subagentPolicy?.allowEdits === true)
    : registeredInternal;
  let configurableInternalToolNames = uniqueNames(selected?.internal ?? defaultInternal)
    .filter((name) => registeredInternalSet.has(name));
  if (typeof maxDepth === "number" && maxDepth <= 0) {
    configurableInternalToolNames = configurableInternalToolNames.filter((name) => name !== "exo");
  }

  const defaultExternal = scoped ? [] : installedExternal;
  const externalToolNames = uniqueNames(selected?.external ?? defaultExternal)
    .filter((name) => installedExternalSet.has(name));

  // External tools are deliberately not native tool schemas. They remain
  // ordinary commands invoked through Bash so the existing summary matcher can
  // render each manifest's own label and color. Keep Bash explicit/effective
  // whenever an external CLI is delegated; never introduce a generic external
  // broker here, because that wrapper would become the visible tool call.
  if (externalToolNames.length > 0 && registeredInternalSet.has(EXTERNAL_TOOL_TRANSPORT)) {
    configurableInternalToolNames = orderedSelection(
      new Set([...configurableInternalToolNames, EXTERNAL_TOOL_TRANSPORT]),
      registeredInternal,
    );
  }

  return {
    internalToolNames: [...configurableInternalToolNames],
    configurableInternalToolNames,
    externalToolNames,
    source: selected ? "explicit" : "default",
    scoped,
  };
}

export function validateToolSelection(
  kind: "internal" | "external",
  names: readonly string[],
): string[] {
  const normalized = uniqueNames(names);
  const available = new Set(kind === "internal" ? getConfigurableInternalToolNames() : getExternalToolNames());
  const unknown = normalized.filter((name) => !available.has(name));
  if (unknown.length > 0) throw new Error(`Unknown or unavailable ${kind} tool${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  return normalized;
}

/** Validate and canonicalize one exact policy, including Bash for external CLIs. */
export function normalizeToolPolicySelection(
  internalNames: readonly string[],
  externalNames: readonly string[],
): ConversationToolPolicy {
  const availableInternal = getConfigurableInternalToolNames();
  const internal = new Set(validateToolSelection("internal", internalNames));
  const external = validateToolSelection("external", externalNames);
  if (external.length > 0 && availableInternal.includes(EXTERNAL_TOOL_TRANSPORT)) {
    internal.add(EXTERNAL_TOOL_TRANSPORT);
  }
  return {
    internal: orderedSelection(internal, availableInternal),
    external,
  };
}

export function assertDelegatedSubset(
  kind: "internal" | "external",
  requested: readonly string[],
  ceiling: readonly string[],
): void {
  const permitted = new Set(ceiling);
  const denied = requested.filter((name) => !permitted.has(name));
  if (denied.length > 0) {
    throw new Error(`Cannot delegate unavailable ${kind} tool${denied.length === 1 ? "" : "s"}: ${denied.join(", ")}`);
  }
}

function orderedSelection(names: ReadonlySet<string>, available: readonly string[]): string[] {
  return available.filter((name) => names.has(name));
}

export function applyToolPolicyMutation(
  conversation: Pick<Conversation, "subagentPolicy" | "subagentMaxDepth" | "toolPolicy">,
  mutation: ToolPolicyMutation,
): ConversationToolPolicy | null {
  if (mutation.action === "reset") return null;

  const availableInternal = getConfigurableInternalToolNames();
  const availableExternal = getExternalToolNames();
  if (mutation.tools.length === 0) throw new Error(`/tools ${mutation.action} requires at least one tool`);
  const current = resolveConversationToolPolicy(conversation);
  const internal = new Set(current.configurableInternalToolNames);
  const external = new Set(current.externalToolNames);
  for (const ref of mutation.tools) {
    const name = ref.name.trim();
    if (!name) throw new Error("Tool names cannot be empty");
    const available = ref.kind === "internal" ? availableInternal : availableExternal;
    if (!available.includes(name)) throw new Error(`Unknown or unavailable ${ref.kind} tool: ${name}`);
    const selected = ref.kind === "internal" ? internal : external;
    if (mutation.action === "allow") selected.add(name);
    else selected.delete(name);
  }
  if (
    mutation.action === "deny"
    && mutation.tools.some((ref) => ref.kind === "internal" && ref.name.trim() === EXTERNAL_TOOL_TRANSPORT)
    && external.size > 0
  ) {
    throw new Error("Cannot disable bash while external tools are enabled; disable those external tools first");
  }
  return normalizeToolPolicySelection(
    orderedSelection(internal, availableInternal),
    orderedSelection(external, availableExternal),
  );
}

export function buildToolPolicySnapshot(conversation: Conversation): ToolPolicySnapshot {
  const resolved = resolveConversationToolPolicy(conversation);
  const enabledInternal = new Set(resolved.configurableInternalToolNames);
  const enabledExternal = new Set(resolved.externalToolNames);
  return {
    convId: conversation.id,
    scoped: resolved.scoped,
    source: resolved.source,
    internal: getRegisteredTools()
      .map((tool) => ({ name: tool.name, label: tool.display.label, enabled: enabledInternal.has(tool.name) })),
    external: getExternalToolStyles().map((tool) => ({
      name: tool.cmd,
      label: tool.label,
      enabled: enabledExternal.has(tool.cmd),
    })),
    shellWarning: enabledInternal.has("bash") || enabledInternal.has("chrono"),
  };
}
