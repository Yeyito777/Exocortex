import { describe, expect, test } from "bun:test";
import { buildMessageLines } from "./conversation";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("tool call rendering", () => {
  test("preserves multiline bash prelude while styling the external tool line", () => {
    const state = {
      messages: [{
        role: "assistant",
        blocks: [{
          type: "tool_call",
          toolCallId: "1",
          toolName: "bash",
          input: {},
          summary: "set -euo pipefail\ncd /home/yeyito/Workspace/Exocortex/daemon\nexo status --json --timeout 120000",
        }],
        metadata: null,
      }],
      pendingAI: null,
      toolRegistry: [{ name: "bash", label: "$", color: "#d19a66" }],
      externalToolStyles: [{ cmd: "exo", label: "Exocortex", color: "#1d9bf0" }],
      showToolOutput: false,
      convId: null,
      queuedMessages: [],
    } as any;

    const rendered = buildMessageLines(state, 120).lines.map(stripAnsi);

    expect(rendered).toContain("  $ set -euo pipefail");
    expect(rendered).toContain("  $ cd /home/yeyito/Workspace/Exocortex/daemon");
    expect(rendered).toContain("  Exocortex status --json --timeout 120000");
  });

  test("preserves same-line wrappers as bash before the external tool", () => {
    const state = {
      messages: [{
        role: "assistant",
        blocks: [{
          type: "tool_call",
          toolCallId: "1",
          toolName: "bash",
          input: {},
          summary: "env FOO=1 command time exo ls | sed -n '1,3p' --timeout 120000",
        }],
        metadata: null,
      }],
      pendingAI: null,
      toolRegistry: [{ name: "bash", label: "$", color: "#d19a66" }],
      externalToolStyles: [{ cmd: "exo", label: "Exocortex", color: "#1d9bf0" }],
      showToolOutput: false,
      convId: null,
      queuedMessages: [],
    } as any;

    const rendered = buildMessageLines(state, 120).lines.map(stripAnsi);

    expect(rendered).toContain("  $ env FOO=1 command time");
    expect(rendered).toContain("  Exocortex ls | sed -n '1,3p' --timeout 120000");
  });
});
