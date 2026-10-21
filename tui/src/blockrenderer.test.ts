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
  test("renders the piecewise counterexample from conversation 1791391190536-s3rmv2", () => {
    const block: Block = {
      type: "text",
      text: String.raw`Exactly—the key is **continuity of the outer function at the inner limit**.

If \(f(x)\to L\) and \(g\) is continuous at \(L\), then
\[
g(f(x))\to g(L).
\]
This applies to \(g(t)=e^t\).

But knowing only \(\lim_{t\to L}g(t)\) says **nothing about \(g(L)\)**. The inner function might equal \(L\) repeatedly.

For example, take \(a=0\):
\[
f(x)=
\begin{cases}
1,&x\le0,\\
1+x,&x>0,
\end{cases}
\qquad
g(t)=
\begin{cases}
0,&t=1,\\
2,&t\ne1.
\end{cases}
\]
Then \(f(x)\to1\) and \(\lim_{t\to1}g(t)=2\), but
\[
g(f(x))=
\begin{cases}
0,&x\le0,\\
2,&x>0.
\end{cases}
\]
So the composition has **no limit** at \(0\).`,
    };
    const rendered = renderBlockCached(block, 120, [], [], false);
    const plain = rendered.lines.map(line => stripAnsi(line).replace(/\u00A0/g, " "));
    expect(plain).toContain("  But knowing only lim_(t→L) g(t) says nothing about g(L). The inner function might equal L repeatedly.");
    expect(plain).toContain("  Then f(x) → 1 and lim_(t→1) g(t) = 2, but");
    const definitions = plain.findIndex(line => line.includes("f(x) = ⎧"));
    expect(plain.slice(definitions, definitions + 2)).toEqual([
      "    f(x) = ⎧ 1,      x ≤ 0,     g(t) = ⎧ 0,  t = 1,",
      "           ⎩ 1 + x,  x > 0,            ⎩ 2,  t ≠ 1.",
    ]);
    // Display rows indent by two inside the block's own two-column margin;
    // a whole-line copy yields the TeX source.
    expect(rendered.copy?.[definitions]).toMatchObject({ text: plain[definitions].slice(4), displayStart: 4 });
    expect(rendered.copy?.[definitions]?.source).toStartWith(String.raw`\[` + "\nf(x)=");
    expect(rendered.copy?.[definitions + 1]).toMatchObject({ text: plain[definitions + 1].slice(4), displayStart: 4, source: null });
    const composition = plain.findIndex(line => line.includes("g(f(x)) = ⎧"));
    expect(plain.slice(composition, composition + 2)).toEqual([
      "    g(f(x)) = ⎧ 0,  x ≤ 0,",
      "              ⎩ 2,  x > 0.",
    ]);
    expect(plain.join("\n")).not.toMatch(/[\uE003\uE004]/);
  });

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
      "    |x₁ + ⋯ + xₙ₊₁| ≤ |x₁ + ⋯ + xₙ| + |xₙ₊₁|.",
      "  The missing term is necessary.",
    ]);
    expect(rendered.copy?.[1]).toEqual({
      text: "|x₁ + ⋯ + xₙ₊₁| ≤ |x₁ + ⋯ + xₙ| + |xₙ₊₁|.",
      displayStart: 4,
      source: [String.raw`\[`, String.raw`|x_1+\cdots+x_{n+1}|`, String.raw`\le |x_1+\cdots+x_n|+|x_{n+1}|.`, String.raw`\]`].join("\n"),
    });
  });
});

describe("tool-call presentation", () => {
  test("a long subagent prompt collapses behind the tool-output toggle, never truncated", () => {
    const steps = Array.from({ length: 10 }, (_, i) => `Step ${i + 1}.`);
    const prompt = ["Small TUI fix in Exocortex: inline images disappear while the queue prompt is open.", "", "Repo: /tmp/x", ...steps, "Report back."].join("\n");
    const block: Block = {
      type: "tool_call",
      toolCallId: "exo-1",
      toolName: "exo",
      input: { subagent: prompt },
      // History persisted older summaries cut at 100 characters; the input is complete.
      summary: `subagent: ${prompt.replace(/\s+/g, " ").slice(0, 100)}`,
    };
    const registry: ToolDisplayInfo[] = [{ name: "exo", label: "Exocortex", color: "#1d9bf0" }];

    const collapsed = renderBlockCached(block, 60, registry, [], false).lines.map(stripAnsi);
    expect(collapsed).toEqual([
      "  Exocortex subagent: Small TUI fix in Exocortex: inline",
      "  images disappear while the queue prompt is open.",
      "  ",
      "  Repo: /tmp/x",
      "  Step 1.",
      "  Step 2.",
      "  Step 3.",
      "  Step 4.",
      "  … +7 more lines (ctrl+o to expand)",
    ]);

    const expanded = renderBlockCached(block, 60, registry, [], true).lines.map(stripAnsi);
    expect(expanded).toHaveLength(15);
    expect(expanded.slice(-2)).toEqual(["  Step 10.", "  Report back."]);
  });

  test("a subagent prompt of moderate length wraps in full", () => {
    const prompt = "Fix the overlay crop.\n\nRepo: /tmp/x\nReport back.";
    const block: Block = { type: "tool_call", toolCallId: "exo-2", toolName: "exo", input: { subagent: prompt }, summary: `subagent: ${prompt}` };
    const lines = renderBlockCached(block, 60, [{ name: "exo", label: "Exocortex", color: "#1d9bf0" }], [], false).lines.map(stripAnsi);
    expect(lines).toEqual(["  Exocortex subagent: Fix the overlay crop.", "  ", "  Repo: /tmp/x", "  Report back."]);
  });

  test("shell commands always render in full", () => {
    const command = Array.from({ length: 8 }, (_, i) => `echo ${i}`).join("\n");
    const block: Block = { type: "tool_call", toolCallId: "sh-1", toolName: "Bash", input: { command }, summary: command };
    expect(renderBlockCached(block, 60, [], [], false).lines).toHaveLength(8);
  });

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

  test("shows multiline stdin as its external tool's input block, parameters apart", () => {
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
      "  Image generate  --timeout 30000",
      "    ▎ Image input",
      "    ▎ first line",
      "    ▎ ",
      "    ▎ printf 'data, not bash'",
      "    ▎ last line",
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
