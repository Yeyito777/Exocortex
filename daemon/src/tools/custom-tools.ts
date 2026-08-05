/**
 * Conversation-scoped dynamic internal tools.
 *
 * Modules are trusted code, loaded by explicit user request. Their bundled
 * source digest and exported tool metadata are persisted with the conversation,
 * while executable instances remain daemon-local and are recreated lazily.
 */

import { createHash } from "crypto";
import { realpath, stat } from "fs/promises";
import { dirname, extname, resolve } from "path";
import type { Conversation, ConversationCustomToolModule } from "../messages";
import type { Tool } from "./types";

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const TOOL_COLOR = /^#[0-9a-fA-F]{6}$/;
const MAX_CUSTOM_TOOLS_PER_CONVERSATION = 64;

export interface CustomToolModuleContext {
  apiVersion: 1;
  conversationId: string;
  modulePath: string;
  moduleDirectory: string;
  workingDirectory: string;
}

interface MaterializedToolset {
  id?: string;
  tools: Tool[];
  dispose?: () => void | Promise<void>;
}

interface LoadedModule {
  descriptor: ConversationCustomToolModule;
  tools: Tool[];
  dispose?: () => void | Promise<void>;
}

interface ConversationCustomToolRuntime {
  modules: LoadedModule[];
  tools: Tool[];
  toolMap: Map<string, Tool>;
}

export interface CustomToolModuleRequest {
  path: string;
  /** Omit to explicitly accept and pin the current bundled source digest. */
  expected?: ConversationCustomToolModule;
}

const runtimes = new Map<string, ConversationCustomToolRuntime>();
const updateTails = new Map<string, Promise<void>>();
let importNonce = 0;

function cloneDescriptor(module: ConversationCustomToolModule): ConversationCustomToolModule {
  return {
    ...module,
    tools: module.tools.map((tool) => ({ ...tool })),
  };
}

function policyModules(conversation: Pick<Conversation, "toolPolicy">): ConversationCustomToolModule[] {
  return conversation.toolPolicy?.customToolModules?.map(cloneDescriptor) ?? [];
}

function runtimeMatchesDescriptors(
  runtime: ConversationCustomToolRuntime | undefined,
  descriptors: readonly ConversationCustomToolModule[],
): boolean {
  if (!runtime || runtime.modules.length !== descriptors.length) return false;
  return runtime.modules.every((module, index) => (
    module.descriptor.path === descriptors[index]?.path
    && module.descriptor.digest === descriptors[index]?.digest
    && JSON.stringify(module.descriptor.tools) === JSON.stringify(descriptors[index]?.tools)
    && module.descriptor.id === descriptors[index]?.id
  ));
}

async function withConversationUpdate<T>(conversationId: string, update: () => Promise<T>): Promise<T> {
  const previous = updateTails.get(conversationId) ?? Promise.resolve();
  let value!: T;
  const current = previous.catch(() => {}).then(async () => {
    value = await update();
  });
  updateTails.set(conversationId, current);
  try {
    await current;
    return value;
  } finally {
    if (updateTails.get(conversationId) === current) updateTails.delete(conversationId);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolLike(value: unknown): value is Tool {
  if (!isRecord(value)) return false;
  return typeof value.name === "string"
    && typeof value.description === "string"
    && isRecord(value.inputSchema)
    && isRecord(value.display)
    && typeof value.summarize === "function"
    && typeof value.execute === "function";
}

function validateTool(tool: Tool, modulePath: string): Tool {
  if (!TOOL_NAME.test(tool.name)) {
    throw new Error(`Custom tool module ${modulePath} exported invalid tool name '${tool.name}'. Names must match ${TOOL_NAME}.`);
  }
  if (!tool.description.trim()) throw new Error(`Custom tool '${tool.name}' must have a non-empty description`);
  if (!tool.display.label?.trim()) throw new Error(`Custom tool '${tool.name}' must have a display label`);
  if (!TOOL_COLOR.test(tool.display.color)) {
    throw new Error(`Custom tool '${tool.name}' has invalid display color '${tool.display.color}'; expected #RRGGBB`);
  }
  if (tool.isAvailable && !tool.isAvailable()) {
    throw new Error(`Custom tool '${tool.name}' is unavailable in this daemon`);
  }
  return tool;
}

function normalizeToolsetResult(value: unknown, modulePath: string, inheritedId?: string): MaterializedToolset {
  if (isToolLike(value)) return { id: inheritedId, tools: [validateTool(value, modulePath)] };
  if (Array.isArray(value)) {
    if (!value.every(isToolLike)) throw new Error(`Custom tool module ${modulePath} exported an invalid tools array`);
    return { id: inheritedId, tools: value.map((tool) => validateTool(tool, modulePath)) };
  }
  if (!isRecord(value) || !Array.isArray(value.tools) || !value.tools.every(isToolLike)) {
    throw new Error(`Custom tool module ${modulePath} must export a Tool, Tool[], { tools }, or a toolset factory`);
  }
  const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : inheritedId;
  const dispose = typeof value.dispose === "function"
    ? value.dispose as () => void | Promise<void>
    : undefined;
  return {
    id,
    tools: value.tools.map((tool) => validateTool(tool, modulePath)),
    dispose,
  };
}

async function materializeModule(namespace: Record<string, unknown>, context: CustomToolModuleContext): Promise<MaterializedToolset> {
  const candidate = namespace.default ?? namespace.toolset ?? namespace.tool ?? (
    namespace.tools !== undefined || namespace.create !== undefined ? namespace : undefined
  );
  if (candidate === undefined) {
    throw new Error(`Custom tool module ${context.modulePath} has no supported export`);
  }

  if (typeof candidate === "function") {
    return normalizeToolsetResult(await candidate(context), context.modulePath);
  }
  if (isToolLike(candidate) || Array.isArray(candidate)) {
    return normalizeToolsetResult(candidate, context.modulePath);
  }
  if (!isRecord(candidate)) {
    throw new Error(`Custom tool module ${context.modulePath} has an unsupported default export`);
  }
  if (candidate.apiVersion !== undefined && candidate.apiVersion !== 1) {
    throw new Error(`Custom tool module ${context.modulePath} uses unsupported apiVersion ${String(candidate.apiVersion)}; expected 1`);
  }
  const id = typeof candidate.id === "string" && candidate.id.trim() ? candidate.id.trim() : undefined;
  if (typeof candidate.create === "function") {
    return normalizeToolsetResult(await candidate.create(context), context.modulePath, id);
  }
  return normalizeToolsetResult(candidate, context.modulePath, id);
}

interface CompiledModule {
  digest: string;
  code: string;
}

async function compileModule(path: string): Promise<CompiledModule> {
  // Hash Bun's deterministic bundle rather than only the entry file. This pins
  // the statically imported TypeScript/JavaScript dependency closure used by
  // multi-file toolsets. Bundling also makes an accepted reload cache-safe.
  const build = await Bun.build({
    entrypoints: [path],
    target: "bun",
    format: "esm",
    splitting: false,
    sourcemap: "none",
    packages: "bundle",
  });
  if (!build.success) {
    const diagnostics = build.logs.map((entry) => String(entry)).join("\n");
    throw new Error(`Failed to compile custom tool module ${path}${diagnostics ? `:\n${diagnostics}` : ""}`);
  }
  const hash = createHash("sha256");
  const outputs = [...build.outputs].sort((left, right) => left.path.localeCompare(right.path));
  for (const output of outputs) {
    hash.update(output.path);
    hash.update(new Uint8Array(await output.arrayBuffer()));
  }
  const executable = outputs.find((output) => /\.[cm]?js$/i.test(output.path)) ?? outputs[0];
  if (!executable) throw new Error(`Custom tool module ${path} produced no executable output`);
  return {
    digest: `sha256:${hash.digest("hex")}`,
    code: await executable.text(),
  };
}

export async function canonicalizeCustomToolModulePath(path: string, mustExist = true): Promise<string> {
  const absolute = resolve(process.cwd(), path.trim());
  if (!path.trim()) throw new Error("Custom tool module path cannot be empty");
  if (!SUPPORTED_EXTENSIONS.has(extname(absolute).toLowerCase())) {
    throw new Error(`Unsupported custom tool module extension for ${absolute}; expected TypeScript or JavaScript`);
  }
  if (!mustExist) {
    try {
      return await realpath(absolute);
    } catch {
      return absolute;
    }
  }
  const canonical = await realpath(absolute).catch((error) => {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot load custom tool module ${absolute}: ${detail}`);
  });
  const info = await stat(canonical);
  if (!info.isFile()) throw new Error(`Custom tool module is not a file: ${canonical}`);
  return canonical;
}

async function loadModule(
  conversationId: string,
  request: CustomToolModuleRequest,
): Promise<LoadedModule> {
  const path = await canonicalizeCustomToolModulePath(request.path);
  const compiled = await compileModule(path);
  const digest = compiled.digest;
  if (request.expected && request.expected.path !== path) {
    throw new Error(`Custom tool module path changed from ${request.expected.path} to ${path}`);
  }
  if (request.expected && request.expected.digest !== digest) {
    throw new Error(
      `Custom tool module changed since it was enabled: ${path}. Run /tools enable ${path} to review and accept the new version.`,
    );
  }

  // Execute the same bundled local source closure that was hashed above. A data
  // module avoids Bun retaining stale transitive imports after an explicit
  // re-enable. The per-instance comment gives direct Tool exports separate
  // module objects; toolset factories should still own conversation state.
  const instanceCode = `${compiled.code}\n// exocortex custom tool ${conversationId} load ${++importNonce}\n`;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(instanceCode).toString("base64")}`;
  const namespace = await import(moduleUrl) as Record<string, unknown>;
  const materialized = await materializeModule(namespace, {
    apiVersion: 1,
    conversationId,
    modulePath: path,
    moduleDirectory: dirname(path),
    workingDirectory: process.cwd(),
  });
  if (materialized.tools.length === 0) throw new Error(`Custom tool module ${path} exported no tools`);

  const descriptor: ConversationCustomToolModule = {
    path,
    digest,
    ...(materialized.id ? { id: materialized.id } : {}),
    tools: materialized.tools.map((tool) => ({
      name: tool.name,
      label: tool.display.label,
      color: tool.display.color,
    })),
  };
  if (request.expected && (
    request.expected.id !== descriptor.id
    || JSON.stringify(request.expected.tools) !== JSON.stringify(descriptor.tools)
  )) {
    await materialized.dispose?.();
    throw new Error(
      `Custom tool module exports changed since it was enabled: ${path}. Run /tools enable ${path} to review and accept the new version.`,
    );
  }
  return { descriptor, tools: materialized.tools, dispose: materialized.dispose };
}

async function disposeRuntime(runtime: ConversationCustomToolRuntime | undefined): Promise<void> {
  if (!runtime) return;
  await Promise.allSettled(runtime.modules.map(async (module) => module.dispose?.()));
}

/**
 * Atomically replace one conversation's loaded custom-tool set. Requests with
 * an expected descriptor are digest-pinned; requests without one explicitly
 * accept the current file and return the new descriptor for persistence.
 */
export async function installConversationCustomToolModules(
  conversationId: string,
  requests: readonly CustomToolModuleRequest[],
  reservedToolNames: readonly string[],
): Promise<ConversationCustomToolModule[]> {
  return withConversationUpdate(conversationId, async () => {
    const deduplicated = new Map<string, CustomToolModuleRequest>();
    for (const request of requests) {
      const canonical = await canonicalizeCustomToolModulePath(request.path);
      deduplicated.set(canonical, { ...request, path: canonical });
    }
    const normalizedRequests = [...deduplicated.values()];
    if (normalizedRequests.length === 0) {
      const current = runtimes.get(conversationId);
      runtimes.delete(conversationId);
      await disposeRuntime(current);
      return [];
    }
    const expectedDescriptors = normalizedRequests
      .map((request) => request.expected)
      .filter((module): module is ConversationCustomToolModule => module !== undefined);
    const current = runtimes.get(conversationId);
    if (
      normalizedRequests.length === expectedDescriptors.length
      && runtimeMatchesDescriptors(current, expectedDescriptors)
    ) {
      return expectedDescriptors.map(cloneDescriptor);
    }

    const staged: LoadedModule[] = [];
    try {
      for (const request of normalizedRequests) staged.push(await loadModule(conversationId, request));
      const reserved = new Set(reservedToolNames);
      const toolMap = new Map<string, Tool>();
      for (const module of staged) {
        for (const tool of module.tools) {
          if (reserved.has(tool.name)) throw new Error(`Custom tool name conflicts with a built-in tool: ${tool.name}`);
          if (toolMap.has(tool.name)) throw new Error(`Duplicate custom tool name: ${tool.name}`);
          toolMap.set(tool.name, tool);
        }
      }
      if (toolMap.size > MAX_CUSTOM_TOOLS_PER_CONVERSATION) {
        throw new Error(`A conversation may load at most ${MAX_CUSTOM_TOOLS_PER_CONVERSATION} custom tools`);
      }
      const next: ConversationCustomToolRuntime = {
        modules: staged,
        tools: [...toolMap.values()],
        toolMap,
      };
      runtimes.set(conversationId, next);
      await disposeRuntime(current);
      return staged.map((module) => cloneDescriptor(module.descriptor));
    } catch (error) {
      await disposeRuntime({ modules: staged, tools: [], toolMap: new Map() });
      throw error;
    }
  });
}

export async function ensureConversationCustomTools(
  conversation: Pick<Conversation, "id" | "toolPolicy">,
  reservedToolNames: readonly string[],
): Promise<void> {
  const descriptors = policyModules(conversation);
  await installConversationCustomToolModules(
    conversation.id,
    descriptors.map((module) => ({ path: module.path, expected: module })),
    reservedToolNames,
  );
}

export async function clearConversationCustomTools(conversationId: string): Promise<void> {
  await withConversationUpdate(conversationId, async () => {
    const runtime = runtimes.get(conversationId);
    runtimes.delete(conversationId);
    await disposeRuntime(runtime);
  });
}

export function getConversationCustomTools(conversationId: string | undefined): Tool[] {
  if (!conversationId) return [];
  return [...(runtimes.get(conversationId)?.tools ?? [])];
}

export function getConversationCustomTool(conversationId: string | undefined, name: string): Tool | undefined {
  return conversationId ? runtimes.get(conversationId)?.toolMap.get(name) : undefined;
}

export const customToolInternalsForTest = {
  policyModules,
  runtimeCount: () => runtimes.size,
};
