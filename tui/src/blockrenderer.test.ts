import { describe, expect, test } from "bun:test";
import { renderAdaptiveUserMessageRows, renderBlockCached, renderUserMessage } from "./blockrenderer";
import type { Block, ToolDisplayInfo, ExternalToolStyle } from "./messages";
import { theme } from "./theme";
import { termWidth } from "./textwidth";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function userBubbleWidth(line: string): number {
  const backgroundStart = line.indexOf(theme.userBg);
  expect(backgroundStart).toBeGreaterThanOrEqual(0);
  const contentStart = backgroundStart + theme.userBg.length;
  const backgroundEnd = line.indexOf(theme.reset, contentStart);
  expect(backgroundEnd).toBeGreaterThanOrEqual(contentStart);
  return termWidth(stripAnsi(line.slice(contentStart, backgroundEnd)));
}

describe("rehydrated block render caching", () => {
  const registry: ToolDisplayInfo[] = [];
  const styles: ExternalToolStyle[] = [];
  const paint = (block: Block, width = 80, expanded = false, errored = false) =>
    renderBlockCached(block, width, registry, styles, expanded, errored);

  test("reuses presentation after JSON reload without reusing mutable blocks", () => {
    const block: Block = { type: "text", text: "Reloaded **markdown** with [a link](https://example.com/cache)." };
    const rendered = paint(block);
    const reloaded: Block = JSON.parse(JSON.stringify(block));
    expect(reloaded).not.toBe(block);
    expect(paint(reloaded)).toBe(rendered);
    if (reloaded.type === "text") reloaded.text = "Canonical edited text";
    expect(paint(reloaded)).not.toBe(rendered);
    expect(paint(block)).toBe(rendered);
  });

  test("respects width, block type, registries and tool-output visibility", () => {
    const block: Block = { type: "text", text: "Context-sensitive cached block" };
    const rendered = paint(block);
    expect(paint({ ...block }, 40)).not.toBe(rendered);
    expect(paint({ type: "thinking", text: block.text })).not.toBe(rendered);
    expect(renderBlockCached({ ...block }, 80, [], styles, false)).not.toBe(rendered);
    const result: Block = { type: "tool_result", toolCallId: "result-cache", toolName: "bash", output: "Output", isError: false };
    expect(paint({ ...result }, 80, true).lines.length).toBeGreaterThan(paint(result).lines.length);
  });

  test("includes tool name and error status in content identity", () => {
    const block: Block = { type: "tool_call", toolCallId: "call-cache", toolName: "bash", input: {}, summary: "cached command" };
    const rendered = paint(block);
    expect(paint({ ...block, toolName: "browse" })).not.toBe(rendered);
    expect(paint({ ...block }, 80, false, true)).not.toBe(rendered);
    block.toolName = "browse";
    expect(paint(block)).not.toBe(rendered);

    const result: Block = { type: "tool_result", toolCallId: "error-cache", toolName: "bash", output: "same output", isError: false };
    const success = paint(result, 80, true);
    result.isError = true;
    expect(paint(result, 80, true)).not.toBe(success);
  });
});

describe("thinking block rendering", () => {
  test("drops edge newlines but keeps paragraph breaks", () => {
    const rendered = renderBlockCached({ type: "thinking", text: "\nFirst.\n\nSecond.\n\n" }, 80, [], [], false);
    expect(rendered.lines.map(line => stripAnsi(line).trimEnd())).toEqual(["  First.", "", "  Second."]);
  });
});

describe("adaptive user message rendering", () => {
  test("sizes a partially visible bubble from the longest line in the complete message", () => {
    const cols = 80;
    const text = "this wider line has already scrolled outside the viewport\nshort";
    const fullMessage = renderUserMessage(text, cols);
    const visibleRows = renderAdaptiveUserMessageRows(
      text,
      { lineIndex: 1, offset: 0 },
      { lineIndex: 2, offset: 0 },
      () => cols,
    );

    expect(visibleRows).toHaveLength(1);
    expect(userBubbleWidth(visibleRows[0].line)).toBe(userBubbleWidth(fullMessage.lines[0]));
  });
});

describe("assistant display math rendering", () => {
  test("renders math after prose and preserves the indented copy projection", () => {
    const block: Block = {
      type: "text",
      text: [
        "Triangle inequality gives:",
        String.raw`\[`,
        String.raw`|x_1+\cdots+x_{n+1}|`,
        String.raw`\le |x_1+\cdots+x_n|+|x_{n+1}|.`,
        String.raw`\]`,
        "The missing term is necessary.",
      ].join("\n"),
    };
    const rendered = renderBlockCached(block, 100, [], [], false);

    expect(rendered.lines.map(stripAnsi)).toEqual([
      "  Triangle inequality gives:",
      "  |x₁+⋯+xₙ₊₁| ≤ |x₁+⋯+xₙ|+|xₙ₊₁|.",
      "  The missing term is necessary.",
    ]);
    expect(rendered.copy?.[1]).toEqual({
      text: "|x₁+⋯+xₙ₊₁| ≤ |x₁+⋯+xₙ|+|xₙ₊₁|.",
      displayStart: 2,
    });
  });
});

describe("tool-call presentation", () => {
  test("uses invocation-local styles for conversation-scoped internal tools", () => {
    const block: Block = {
      type: "tool_call",
      toolCallId: "custom-1",
      toolName: "minecraft_grep",
      input: { query: "copper" },
      summary: "copper",
      presentation: {
        toolStyle: { name: "minecraft_grep", label: "Minecraft Grep", color: "#12abef" },
      },
    };

    const rendered = renderBlockCached(block, 80, [], [], false);

    expect(stripAnsi(rendered.lines[0] ?? "")).toBe("  Minecraft Grep copper");
  });

  test("uses snapshotted Bash styles before the global external-tool registry", () => {
    const block: Block = {
      type: "tool_call",
      toolCallId: "local-1",
      toolName: "bash",
      input: { command: "./scripts/exo-deploy production" },
      summary: "./scripts/exo-deploy production",
      presentation: {
        bashStyles: [{ cmd: "./scripts/exo-deploy", label: "Deploy", color: "#7aa2f7" }],
      },
    };

    const rendered = renderBlockCached(
      block,
      80,
      [{ name: "bash", label: "$", color: "#d19a66" }],
      [{ cmd: "./scripts/exo-deploy", label: "Global", color: "#ffffff" }],
      false,
    );

    expect(stripAnsi(rendered.lines[0] ?? "")).toBe("  Deploy production");
  });

  test("keeps an attached redirection visible after a local command match", () => {
    const block: Block = {
      type: "tool_call",
      toolCallId: "local-redirection",
      toolName: "bash",
      input: { command: "./scripts/exo-deploy>result.txt" },
      summary: "./scripts/exo-deploy>result.txt",
      presentation: {
        bashStyles: [{ cmd: "./scripts/exo-deploy", label: "Deploy", color: "#7aa2f7" }],
      },
    };

    const rendered = renderBlockCached(
      block,
      80,
      [{ name: "bash", label: "$", color: "#d19a66" }],
      [],
      false,
    );

    expect(stripAnsi(rendered.lines[0] ?? "")).toBe("  Deploy >result.txt");
  });

  test("keeps multiline stdin attached to its parent external tool call", () => {
    const stdin = "first line\n\nprintf 'data, not bash'\nlast line";
    const block: Block = {
      type: "tool_call",
      toolCallId: "external-stdin",
      toolName: "bash",
      input: { command: "image generate", stdin, timeout: 30_000 },
      summary: `image generate --stdin ${stdin} --timeout 30000`,
    };

    const rendered = renderBlockCached(
      block,
      120,
      [{ name: "bash", label: "$", color: "#d19a66" }],
      [{ cmd: "image", label: "Image", color: "#ff79c6" }],
      false,
    );

    expect(rendered.lines.map(stripAnsi)).toEqual([
      "  Image generate --stdin first line",
      "  ",
      "  printf 'data, not bash'",
      "  last line --timeout 30000",
    ]);
  });

  test("rejects malformed persisted presentation metadata", () => {
    const block = {
      type: "tool_call" as const,
      toolCallId: "local-2",
      toolName: "bash",
      input: { command: "./exo-bad" },
      summary: "./exo-bad",
      presentation: {
        bashStyles: [{ cmd: "./exo-bad", label: "Bad\nLabel", color: "not-a-color" }],
      },
    } as Block;

    const rendered = renderBlockCached(
      block,
      80,
      [{ name: "bash", label: "$", color: "#d19a66" }],
      [],
      false,
    );

    expect(stripAnsi(rendered.lines[0] ?? "")).toBe("  $ ./exo-bad");
  });
});
