import { describe, expect, test } from "bun:test";
import { renderAdaptiveUserMessageRows, renderBlockCached, renderUserMessage } from "./blockrenderer";
import type { Block } from "./messages";
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
