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

  test("preserves same-line setup command before an &&-chained external tool", () => {
    const state = {
      messages: [{
        role: "assistant",
        blocks: [{
          type: "tool_call",
          toolCallId: "1",
          toolName: "bash",
          input: {},
          summary: "cd /home/yeyito/Workspace/Exocortex/external-tools/exo-cli && exo --help --timeout 120000",
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

    expect(rendered).toContain("  $ cd /home/yeyito/Workspace/Exocortex/external-tools/exo-cli &&");
    expect(rendered).toContain("  Exocortex --help --timeout 120000");
  });

  test("styles external tool after a cat heredoc bash prelude", () => {
    const state = {
      messages: [{
        role: "assistant",
        blocks: [{
          type: "tool_call",
          toolCallId: "1",
          toolName: "bash",
          input: {},
          summary: [
            "cat > /tmp/kittenml-reply.txt <<'EOF'",
            "Hi!",
            "EOF",
            "",
            "gmail reply -f /tmp/kittenml-reply.txt 19d68e0c3d19ece3 --timeout 120000",
          ].join("\n"),
        }],
        metadata: null,
      }],
      pendingAI: null,
      toolRegistry: [{ name: "bash", label: "$", color: "#d19a66" }],
      externalToolStyles: [{ cmd: "gmail", label: "Gmail", color: "#4ddbb7" }],
      showToolOutput: false,
      convId: null,
      queuedMessages: [],
    } as any;

    const rendered = buildMessageLines(state, 120).lines.map(stripAnsi);

    expect(rendered).toContain("  $ cat > /tmp/kittenml-reply.txt <<'EOF'");
    expect(rendered).toContain("  $ Hi!");
    expect(rendered).toContain("  Gmail reply -f /tmp/kittenml-reply.txt 19d68e0c3d19ece3 --timeout 120000");
  });

  test("styles whatsapp command with a multiline quoted message body", () => {
    const state = {
      messages: [{
        role: "assistant",
        blocks: [{
          type: "tool_call",
          toolCallId: "1",
          toolName: "bash",
          input: {},
          summary: [
            'whatsapp send Mom "Hola ma, update rápido 🙏',
            '',
            'Ya nos sirvió mucho lo que mandaste por email:',
            '- ✅ la referencia bancaria de Banco General',
            'Gracias 💙"',
          ].join("\n"),
        }],
        metadata: null,
      }],
      pendingAI: null,
      toolRegistry: [{ name: "bash", label: "$", color: "#d19a66" }],
      externalToolStyles: [{ cmd: "whatsapp", label: "WhatsApp", color: "#25d366" }],
      showToolOutput: false,
      convId: null,
      queuedMessages: [],
    } as any;

    const rendered = buildMessageLines(state, 120).lines.map(stripAnsi);

    expect(rendered).toContain('  WhatsApp send Mom "Hola ma, update rápido 🙏');
    expect(rendered).toContain('  Ya nos sirvió mucho lo que mandaste por email:');
    expect(rendered).toContain('  - ✅ la referencia bancaria de Banco General');
    expect(rendered).toContain('  Gracias 💙"');
  });

  test("styles same-line embedded external tools even without prompt prefixes", () => {
    const state = {
      messages: [{
        role: "assistant",
        blocks: [{
          type: "tool_call",
          toolCallId: "1",
          toolName: "bash",
          input: {},
          summary: [
            "echo '--- MOM ---' && whatsapp messages Mom -n 20 && echo '\\n--- DAD ---' && whatsapp messages \"Aurelio Linero Archibold\" -n 20",
            "echo '--- EMAILS ---' && gmail search \"newer_than:2d (from:YESENIAB@iadb.org OR from:adobesign@adobesign.com OR IFARHU OR estado de cuenta OR carta de trabajo OR talonario OR signed OR signature requested OR Productos de Prestigio OR Aurelio)\" --limit 25",
            "ls -lt ~/Documents/UofT/proof-of-funds ~/Documents/UofT 2>/dev/null | sed -n '1,220p' --timeout 3600000",
          ].join("\n"),
        }],
        metadata: null,
      }],
      pendingAI: null,
      toolRegistry: [{ name: "bash", label: "$", color: "#d19a66" }],
      externalToolStyles: [
        { cmd: "gmail", label: "Gmail", color: "#4ddbb7" },
        { cmd: "whatsapp", label: "WhatsApp", color: "#25d366" },
      ],
      showToolOutput: false,
      convId: null,
      queuedMessages: [],
    } as any;

    const rendered = buildMessageLines(state, 240).lines.map(stripAnsi);

    expect(rendered).toContain("  $ echo '--- MOM ---' &&");
    expect(rendered).toContain("  WhatsApp messages Mom -n 20 &&");
    expect(rendered).toContain("  $ echo '\\n--- DAD ---' &&");
    expect(rendered).toContain('  WhatsApp messages "Aurelio Linero Archibold" -n 20');
    expect(rendered).toContain("  $ echo '--- EMAILS ---' &&");
    expect(rendered).toContain('  Gmail search "newer_than:2d (from:YESENIAB@iadb.org OR from:adobesign@adobesign.com OR IFARHU OR estado de cuenta OR carta de trabajo OR talonario OR signed OR signature requested OR Productos de Prestigio OR Aurelio)" --limit 25');
    expect(rendered).toContain("  $ ls -lt ~/Documents/UofT/proof-of-funds ~/Documents/UofT 2>/dev/null | sed -n '1,220p' --timeout 3600000");
  });

  test("styles prompt-prefixed transcript lines with embedded external tools", () => {
    const state = {
      messages: [{
        role: "assistant",
        blocks: [{
          type: "tool_call",
          toolCallId: "1",
          toolName: "bash",
          input: {},
          summary: [
            "$ echo '--- MOM ---' && whatsapp messages Mom -n 20 && echo '\\n--- DAD ---' && whatsapp messages \"Aurelio Linero Archibold\" -n 20",
            "$ echo '--- EMAILS ---' && gmail search \"newer_than:2d (from:YESENIAB@iadb.org OR from:adobesign@adobesign.com OR IFARHU OR estado de cuenta OR carta de trabajo OR talonario OR signed OR signature requested OR Productos de Prestigio OR Aurelio)\" --limit 25",
            "$ ls -lt ~/Documents/UofT/proof-of-funds ~/Documents/UofT 2>/dev/null | sed -n '1,220p'",
          ].join("\n"),
        }],
        metadata: null,
      }],
      pendingAI: null,
      toolRegistry: [{ name: "bash", label: "$", color: "#d19a66" }],
      externalToolStyles: [
        { cmd: "gmail", label: "Gmail", color: "#4ddbb7" },
        { cmd: "whatsapp", label: "WhatsApp", color: "#25d366" },
      ],
      showToolOutput: false,
      convId: null,
      queuedMessages: [],
    } as any;

    const rendered = buildMessageLines(state, 240).lines.map(stripAnsi);

    expect(rendered).toContain("  $ echo '--- MOM ---' &&");
    expect(rendered).toContain("  WhatsApp messages Mom -n 20 &&");
    expect(rendered).toContain("  $ echo '\\n--- DAD ---' &&");
    expect(rendered).toContain('  WhatsApp messages "Aurelio Linero Archibold" -n 20');
    expect(rendered).toContain("  $ echo '--- EMAILS ---' &&");
    expect(rendered).toContain('  Gmail search "newer_than:2d (from:YESENIAB@iadb.org OR from:adobesign@adobesign.com OR IFARHU OR estado de cuenta OR carta de trabajo OR talonario OR signed OR signature requested OR Productos de Prestigio OR Aurelio)" --limit 25');
    expect(rendered).toContain("  $ ls -lt ~/Documents/UofT/proof-of-funds ~/Documents/UofT 2>/dev/null | sed -n '1,220p'");
  });

  test("styles external tools after a piped multiline heredoc/subshell prelude", () => {
    const state = {
      messages: [{
        role: "assistant",
        blocks: [{
          type: "tool_call",
          toolCallId: "1",
          toolName: "bash",
          input: {},
          summary: [
            "kill 305721 2>/dev/null || true",
            "( cat <<'EOF'",
            "You are helping identify which fictional characters best match a user, based on evidence from many prior conversations.",
            "EOF",
            "cat /tmp/exo_character_evidence.md ) | exo llm -- --model openai/gpt-5.4 --timeout 600 --timeout 720000",
          ].join("\n"),
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

    const rendered = buildMessageLines(state, 240).lines.map(stripAnsi);

    expect(rendered).toContain("  $ kill 305721 2>/dev/null || true");
    expect(rendered).toContain("  $ cat /tmp/exo_character_evidence.md ) |");
    expect(rendered).toContain("  Exocortex llm -- --model openai/gpt-5.4 --timeout 600 --timeout 720000");
  });
});
