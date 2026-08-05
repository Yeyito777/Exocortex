import type { ToolPolicyMutation, ToolPolicySnapshot } from "@exocortex/shared/messages";
import type { Conversation, ConversationCustomToolModule, ConversationToolPolicy } from "./messages";
import { getExternalToolNames, getExternalToolStyles } from "./external-tools";
import { getRegisteredTools } from "./tools/registry";
import {
  canonicalizeCustomToolModulePath,
  clearConversationCustomTools,
  installConversationCustomToolModules,
} from "./tools/custom-tools";

export const RESEARCH_INTERNAL_TOOLS = ["read", "glob", "grep", "browse"] as const;
export const LEGACY_EDIT_INTERNAL_TOOLS = ["bash", "write", "edit", "patch", "chrono"] as const;
const EXTERNAL_TOOL_TRANSPORT = "bash";

function uniqueNames(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function cloneModules(modules: readonly ConversationCustomToolModule[] | undefined): ConversationCustomToolModule[] {
  return modules?.map((module) => ({
    ...module,
    tools: module.tools.map((tool) => ({ ...tool })),
  })) ?? [];
}

function conversationModules(conversation?: Pick<Conversation, "toolPolicy">): ConversationCustomToolModule[] {
  return cloneModules(conversation?.toolPolicy?.customToolModules);
}

function customToolNames(modules: readonly ConversationCustomToolModule[]): string[] {
  return uniqueNames(modules.flatMap((module) => module.tools.map((tool) => tool.name)));
}

export function getConfigurableInternalToolNames(
  conversation?: Pick<Conversation, "toolPolicy">,
): string[] {
  return uniqueNames([
    ...getRegisteredTools().map((tool) => tool.name),
    ...customToolNames(conversationModules(conversation)),
  ]);
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
  const registeredInternal = getConfigurableInternalToolNames(conversation);
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
  conversation?: Pick<Conversation, "toolPolicy">,
): string[] {
  const normalized = uniqueNames(names);
  const available = new Set(kind === "internal" ? getConfigurableInternalToolNames(conversation) : getExternalToolNames());
  const unknown = normalized.filter((name) => !available.has(name));
  if (unknown.length > 0) throw new Error(`Unknown or unavailable ${kind} tool${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  return normalized;
}

/** Validate and canonicalize one exact policy, including Bash for external CLIs. */
export function normalizeToolPolicySelection(
  internalNames: readonly string[],
  externalNames: readonly string[],
  customToolModules: readonly ConversationCustomToolModule[] = [],
): ConversationToolPolicy {
  const modules = cloneModules(customToolModules);
  const selectionContext = { toolPolicy: { internal: [], external: [], customToolModules: modules } };
  const availableInternal = getConfigurableInternalToolNames(selectionContext);
  const internal = new Set(validateToolSelection("internal", internalNames, selectionContext));
  const external = validateToolSelection("external", externalNames);
  if (external.length > 0 && availableInternal.includes(EXTERNAL_TOOL_TRANSPORT)) {
    internal.add(EXTERNAL_TOOL_TRANSPORT);
  }
  return {
    internal: orderedSelection(internal, availableInternal),
    external,
    ...(modules.length > 0 ? { customToolModules: modules } : {}),
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

async function restoreLoadedModules(
  conversation: Pick<Conversation, "id">,
  modules: readonly ConversationCustomToolModule[],
): Promise<void> {
  if (modules.length === 0) {
    await clearConversationCustomTools(conversation.id);
    return;
  }
  await installConversationCustomToolModules(
    conversation.id,
    modules.map((module) => ({ path: module.path, expected: module })),
    getRegisteredTools().map((tool) => tool.name),
  );
}

export async function applyToolPolicyMutation(
  conversation: Pick<Conversation, "id" | "subagentPolicy" | "subagentMaxDepth" | "toolPolicy">,
  mutation: ToolPolicyMutation,
): Promise<ConversationToolPolicy | null> {
  if (mutation.action !== "enable" && mutation.action !== "disable" && mutation.action !== "reset") {
    throw new Error(`Unknown /tools action: ${String((mutation as { action?: unknown }).action)}`);
  }
  if (mutation.action === "reset") {
    await clearConversationCustomTools(conversation.id);
    return null;
  }

  const modulePaths = uniqueNames(mutation.modulePaths ?? []);
  if (mutation.tools.length === 0 && modulePaths.length === 0) {
    throw new Error(`/tools ${mutation.action} requires at least one tool or module path`);
  }

  const previousModules = conversationModules(conversation);
  let modules = cloneModules(previousModules);
  const automaticallyEnabled = new Set<string>();
  const automaticallyDisabled = new Set<string>();
  let changedLoadedModules = false;

  try {
    if (modulePaths.length > 0 && mutation.action === "enable") {
      const requestedPaths = await Promise.all(modulePaths.map((path) => canonicalizeCustomToolModulePath(path)));
      modules = await installConversationCustomToolModules(
        conversation.id,
        [
          ...previousModules.map((module) => ({ path: module.path, expected: module })),
          ...requestedPaths.map((path) => ({ path })),
        ],
        getRegisteredTools().map((tool) => tool.name),
      );
      const requested = new Set(requestedPaths);
      for (const module of modules) {
        if (requested.has(module.path)) module.tools.forEach((tool) => automaticallyEnabled.add(tool.name));
      }
      changedLoadedModules = true;
    } else if (modulePaths.length > 0) {
      const requestedPaths = new Set(await Promise.all(
        modulePaths.map((path) => canonicalizeCustomToolModulePath(path, false)),
      ));
      const removed = previousModules.filter((module) => requestedPaths.has(module.path));
      const unknown = [...requestedPaths].filter((path) => !removed.some((module) => module.path === path));
      if (unknown.length > 0) throw new Error(`Custom tool module is not attached to this conversation: ${unknown.join(", ")}`);
      removed.forEach((module) => module.tools.forEach((tool) => automaticallyDisabled.add(tool.name)));
      modules = previousModules.filter((module) => !requestedPaths.has(module.path));
      await restoreLoadedModules(conversation, modules);
      changedLoadedModules = true;
    }

    const availableInternal = uniqueNames([
      ...getRegisteredTools().map((tool) => tool.name),
      ...customToolNames(modules),
    ]);
    const availableExternal = getExternalToolNames();
    const current = resolveConversationToolPolicy(conversation);
    const internal = new Set(current.configurableInternalToolNames);
    const external = new Set(current.externalToolNames);

    for (const name of automaticallyEnabled) internal.add(name);
    for (const name of automaticallyDisabled) internal.delete(name);

    for (const ref of mutation.tools) {
      const name = ref.name.trim();
      if (!name) throw new Error("Tool names cannot be empty");
      const available = ref.kind === "internal" ? availableInternal : availableExternal;
      if (!available.includes(name)) throw new Error(`Unknown or unavailable ${ref.kind} tool: ${name}`);
      const selected = ref.kind === "internal" ? internal : external;
      if (mutation.action === "enable") selected.add(name);
      else selected.delete(name);
    }
    if (
      mutation.action === "disable"
      && mutation.tools.some((ref) => ref.kind === "internal" && ref.name.trim() === EXTERNAL_TOOL_TRANSPORT)
      && external.size > 0
    ) {
      throw new Error("Cannot disable bash while external tools are enabled; disable those external tools first");
    }
    return normalizeToolPolicySelection(
      orderedSelection(internal, availableInternal),
      orderedSelection(external, availableExternal),
      modules,
    );
  } catch (error) {
    if (changedLoadedModules) {
      await restoreLoadedModules(conversation, previousModules).catch(() => {});
    }
    throw error;
  }
}

export function buildToolPolicySnapshot(
  conversation: Pick<Conversation, "id" | "subagentPolicy" | "subagentMaxDepth" | "toolPolicy">,
): ToolPolicySnapshot {
  const resolved = resolveConversationToolPolicy(conversation);
  const enabledInternal = new Set(resolved.configurableInternalToolNames);
  const enabledExternal = new Set(resolved.externalToolNames);
  const modules = conversationModules(conversation);
  return {
    convId: conversation.id,
    scoped: resolved.scoped,
    source: resolved.source,
    internal: [
      ...getRegisteredTools().map((tool) => ({
        name: tool.name,
        label: tool.display.label,
        enabled: enabledInternal.has(tool.name),
      })),
      ...modules.flatMap((module) => module.tools.map((tool) => ({
        name: tool.name,
        label: tool.label,
        color: tool.color,
        enabled: enabledInternal.has(tool.name),
        modulePath: module.path,
      }))),
    ],
    external: getExternalToolStyles().map((tool) => ({
      name: tool.cmd,
      label: tool.label,
      enabled: enabledExternal.has(tool.cmd),
    })),
    modules: modules.map((module) => ({
      path: module.path,
      digest: module.digest,
      tools: module.tools.map((tool) => tool.name),
    })),
    shellWarning: enabledInternal.has("bash") || enabledInternal.has("chrono"),
  };
}
