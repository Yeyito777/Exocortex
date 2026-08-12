import type {
  Block,
  ConversationBtw,
  ExternalToolStyle,
  ToolCallPresentation,
  ToolDisplayInfo,
} from "../messages";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSafeDisplayText(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

function normalizeToolStyle(value: unknown): ToolDisplayInfo | undefined {
  if (!isRecord(value)
      || !isSafeDisplayText(value.name, 128)
      || !isSafeDisplayText(value.label, 64)
      || !isHexColor(value.color)) return undefined;
  return { name: value.name, label: value.label, color: value.color };
}

function normalizeBashStyles(value: unknown): ExternalToolStyle[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const styles = value.flatMap((item): ExternalToolStyle[] => {
    if (!isRecord(item)
        || !isSafeDisplayText(item.cmd, 1_024)
        || !isSafeDisplayText(item.label, 64)
        || !isHexColor(item.color)) return [];
    return [{ cmd: item.cmd, label: item.label, color: item.color }];
  });
  return styles.length > 0 ? styles : undefined;
}

function normalizePresentation(value: unknown): ToolCallPresentation | undefined {
  if (!isRecord(value)) return undefined;
  const bashStyles = normalizeBashStyles(value.bashStyles);
  const toolStyle = normalizeToolStyle(value.toolStyle);
  if (!bashStyles && !toolStyle) return undefined;
  return {
    ...(bashStyles ? { bashStyles } : {}),
    ...(toolStyle ? { toolStyle } : {}),
  };
}

/** Validate persisted display blocks and upgrade pre-block BTW answers from text. */
export function normalizeBtwBlocks(value: unknown, legacyText = ""): Block[] {
  if (!Array.isArray(value)) return legacyText ? [{ type: "text", text: legacyText }] : [];

  const blocks = value.flatMap((item): Block[] => {
    if (!isRecord(item)) return [];
    if ((item.type === "text" || item.type === "thinking") && typeof item.text === "string") {
      return [{ type: item.type, text: item.text }];
    }
    if (item.type === "tool_call"
        && typeof item.toolCallId === "string"
        && typeof item.toolName === "string"
        && isRecord(item.input)
        && typeof item.summary === "string") {
      const presentation = normalizePresentation(item.presentation);
      return [{
        type: "tool_call",
        toolCallId: item.toolCallId,
        toolName: item.toolName,
        input: structuredClone(item.input),
        summary: item.summary,
        ...(presentation ? { presentation } : {}),
      }];
    }
    if (item.type === "tool_result"
        && typeof item.toolCallId === "string"
        && typeof item.toolName === "string"
        && typeof item.output === "string"
        && typeof item.isError === "boolean") {
      return [{
        type: "tool_result",
        toolCallId: item.toolCallId,
        toolName: item.toolName,
        output: item.output,
        isError: item.isError,
      }];
    }
    return [];
  });

  // A malformed/empty blocks field from an intermediate build must not erase an
  // otherwise valid legacy answer.
  return blocks.length > 0 || !legacyText ? blocks : [{ type: "text", text: legacyText }];
}

export function textFromBtwBlocks(blocks: readonly Block[]): string {
  return blocks
    .filter((block): block is Extract<Block, { type: "text" }> => block.type === "text")
    .map(block => block.text)
    .join("");
}

export function cloneBtw(btw: ConversationBtw): ConversationBtw {
  return {
    ...btw,
    blocks: normalizeBtwBlocks(btw.blocks, btw.text),
  };
}
