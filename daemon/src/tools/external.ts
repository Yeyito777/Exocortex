import type { Tool, ToolExecutionContext, ToolResult, ToolSummary } from "./types";
import { getExternalToolCount, runExternalTool } from "../external-tools";
import { socketPath } from "@exocortex/shared/paths";

function stringArray(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return null;
  return value as string[];
}

async function execute(
  input: Record<string, unknown>,
  context?: ToolExecutionContext,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const name = typeof input.tool === "string" ? input.tool.trim() : "";
  if (!name) return { output: "Error: missing 'tool' parameter", isError: true };
  const args = stringArray(input.args);
  if (!args) return { output: "Error: 'args' must be an array of strings", isError: true };
  if (args.length > 256 || args.some((arg) => Buffer.byteLength(arg) > 256 * 1024)) {
    return { output: "Error: external tool argument limits exceeded", isError: true };
  }
  const allowed = context?.externalToolNames;
  if (allowed && !allowed.includes(name)) {
    return { output: `External tool unavailable in this conversation: ${name}`, isError: true };
  }
  if (input.stdin !== undefined && typeof input.stdin !== "string") {
    return { output: "Error: 'stdin' must be a string", isError: true };
  }
  const timeoutSeconds = input.timeout_seconds === undefined ? 300 : Number(input.timeout_seconds);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 86_400) {
    return { output: "Error: 'timeout_seconds' must be greater than 0 and at most 86400", isError: true };
  }

  try {
    const result = await runExternalTool(
      name,
      args,
      input.stdin as string | undefined,
      signal,
      timeoutSeconds * 1000,
      undefined,
      {
        EXOCORTEX_SOCKET: socketPath(),
        ...(context?.conversationId ? { EXOCORTEX_PARENT_CONV_ID: context.conversationId } : {}),
        ...(context?.provider ? { EXOCORTEX_PARENT_PROVIDER: context.provider } : {}),
        ...(context?.model ? { EXOCORTEX_PARENT_MODEL: context.model } : {}),
      },
    );
    const status = result.timedOut
      ? `External tool timed out after ${timeoutSeconds} seconds.`
      : result.signal ? `External tool terminated by ${result.signal}.` : "";
    const output = [result.output, status].filter(Boolean).join("\n");
    return {
      output,
      isError: result.timedOut || result.exitCode !== 0 || result.signal !== null,
      exitCode: result.exitCode,
    };
  } catch (error) {
    return {
      output: `External tool error: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
      failureKind: "infrastructure",
    };
  }
}

function summarize(input: Record<string, unknown>): ToolSummary {
  const name = typeof input.tool === "string" ? input.tool : "external";
  const args = Array.isArray(input.args) ? input.args.filter((arg): arg is string => typeof arg === "string") : [];
  return { label: "External", detail: [name, ...args].join(" ") };
}

export const external: Tool = {
  name: "external",
  description: "Run one enabled Exocortex external CLI without granting arbitrary shell access. Pass CLI arguments as a literal argv array and opaque input through stdin.",
  inputSchema: {
    type: "object",
    properties: {
      tool: { type: "string", description: "Enabled external tool manifest name, such as google or gmail." },
      args: { type: "array", items: { type: "string" }, description: "Literal CLI argument vector, excluding the executable name." },
      stdin: { type: "string", description: "Optional exact UTF-8 standard input for opaque payloads." },
      timeout_seconds: { type: "number", description: "Positive execution timeout in seconds; defaults to 300." },
    },
    required: ["tool"],
    additionalProperties: false,
  },
  systemHint: "Use this restricted runner for enabled external CLIs. Put the manifest command name in `tool`, structural arguments in `args`, and opaque bodies/prompts in `stdin`. Run the selected CLI with `args: [\"-h\"]` when you need its usage reference.",
  isAvailable: () => getExternalToolCount() > 0,
  parallelSafety: "exclusive",
  defaultTimeoutMs: null,
  settleOnAbort: true,
  display: { label: "External", color: "#4ddbb7" },
  summarize,
  execute,
};
