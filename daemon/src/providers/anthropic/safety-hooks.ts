/**
 * The Exocortex safety denylist for Claude Code's own tools.
 *
 * Claude Code runs Read, Grep, Bash and the rest itself, never through the
 * Exocortex tool executor, so the denylist is applied by a PreToolUse hook.
 * Exocortex's MCP host tools already go through the executor and are skipped.
 */
import type { HookCallbackMatcher, HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { evaluatePathSafety, evaluateToolCallSafety, formatSafetyBlock } from "../../safety";

type Mapped = { name: string; input: Record<string, unknown> };

function str(input: Record<string, unknown>, key: string): string | undefined {
  return typeof input[key] === "string" ? input[key] as string : undefined;
}

/** Claude Code's tool call as the equivalent Exocortex tool, for its denylist. */
export function exocortexEquivalent(toolName: string, rawInput: unknown): Mapped | null {
  const input = rawInput && typeof rawInput === "object" ? rawInput as Record<string, unknown> : {};
  const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  switch (toolName) {
    case "Bash": return { name: "bash", input: defined({ command: str(input, "command") }) };
    case "Read": return { name: "read", input: defined({ file_path: str(input, "file_path") }) };
    case "Write": return { name: "write", input: defined({ file_path: str(input, "file_path"), content: str(input, "content") }) };
    case "Edit": return { name: "edit", input: defined({ path: str(input, "file_path"), oldText: str(input, "old_string"), newText: str(input, "new_string") }) };
    case "MultiEdit": return { name: "edit", input: defined({ path: str(input, "file_path"), edits: input.edits }) };
    case "NotebookEdit": return { name: "edit", input: defined({ path: str(input, "notebook_path"), newText: str(input, "new_source") }) };
    case "Grep": return { name: "grep", input: defined({ pattern: str(input, "pattern"), path: str(input, "path"), glob: str(input, "glob"), type: str(input, "type") }) };
    case "Glob": return { name: "glob", input: defined({ pattern: str(input, "pattern"), path: str(input, "path") }) };
    case "WebFetch": return { name: "browse", input: defined({ url: str(input, "url"), prompt: str(input, "prompt") }) };
    default: return null;
  }
}

/** A deny decision for a Claude Code tool call the denylist refuses, or null. */
export function claudeCodeToolDenial(toolName: string, toolInput: unknown, cwd: string): string | null {
  const mapped = exocortexEquivalent(toolName, toolInput);
  if (!mapped) return null;
  const textual = evaluateToolCallSafety(mapped.name, mapped.input);
  if (!textual.allowed) return formatSafetyBlock(textual);
  const resolved = evaluatePathSafety(mapped.name, mapped.input, cwd);
  return resolved.allowed ? null : formatSafetyBlock(resolved);
}

/** PreToolUse hooks for a Claude Code process. Stable shape: adoption re-registers the same callback ids. */
export function claudeCodeSafetyHooks(fallbackCwd: string): Partial<Record<"PreToolUse", HookCallbackMatcher[]>> {
  return {
    PreToolUse: [{
      hooks: [async (input: HookInput): Promise<HookJSONOutput> => {
        if (input.hook_event_name !== "PreToolUse") return {};
        const reason = claudeCodeToolDenial(input.tool_name, input.tool_input, input.cwd || fallbackCwd);
        if (!reason) return {};
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
      }],
    }],
  };
}
