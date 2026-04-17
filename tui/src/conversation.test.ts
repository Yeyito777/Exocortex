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

  test("keeps split parent bash timeout and await args attached to prompt-prefixed external tools", () => {
    const state = {
      messages: [{
        role: "assistant",
        blocks: [{
          type: "tool_call",
          toolCallId: "1",
          toolName: "bash",
          input: {},
          summary: [
            "$ set -euo pipefail",
            "$ vm profiles",
            "$ printf '\\n' ;",
            "$ vm status windows",
            "$  --timeout 120000 --await 30",
            "$ set -euo pipefail",
            "$ ps -eo pid,args | grep '[q]emu-system-x86_64' || true --timeout 120000",
          ].join("\n"),
        }],
        metadata: null,
      }],
      pendingAI: null,
      toolRegistry: [{ name: "bash", label: "$", color: "#d19a66" }],
      externalToolStyles: [{ cmd: "vm", label: "VM", color: "#7c3aed" }],
      showToolOutput: false,
      convId: null,
      queuedMessages: [],
    } as any;

    const rendered = buildMessageLines(state, 240).lines.map(stripAnsi);

    expect(rendered).toContain("  $ set -euo pipefail");
    expect(rendered).toContain("  VM profiles");
    expect(rendered).toContain("  $ printf '\\n' ;");
    expect(rendered).toContain("  VM status windows --timeout 120000 --await 30");
    expect(rendered).not.toContain("  $  --timeout 120000 --await 30");
    expect(rendered).toContain("  $ ps -eo pid,args | grep '[q]emu-system-x86_64' || true --timeout 120000");
  });

  test("styles later external-tool lines in unprompted multiline bash transcripts", () => {
    const state = {
      messages: [{
        role: "assistant",
        blocks: [{
          type: "tool_call",
          toolCallId: "1",
          toolName: "bash",
          input: {},
          summary: [
            "set -euo pipefail",
            "WID=$(xdotool search --name 'QEMU \\(exo-windows\\)' | head -n1)",
            "xdotool windowactivate --sync \"$WID\"",
            "for X in 1040 1060 1080 1100; do",
            "for Y in 530 545 560; do",
            "xdotool mousemove --window \"$WID\" --sync $X $Y click 1",
            "sleep 0.15",
            "done",
            "done",
            "sleep 4",
            "vm screenshot windows --out /home/yeyito/Workspace/virtual-machines/windows/logs/spice-driver-x11click3.png",
            "ls -l /home/yeyito/Workspace/virtual-machines/windows/logs/spice-driver-x11click3.png --timeout 240000",
          ].join("\n"),
        }],
        metadata: null,
      }],
      pendingAI: null,
      toolRegistry: [{ name: "bash", label: "$", color: "#d19a66" }],
      externalToolStyles: [{ cmd: "vm", label: "VM", color: "#7c3aed" }],
      showToolOutput: false,
      convId: null,
      queuedMessages: [],
    } as any;

    const rendered = buildMessageLines(state, 240).lines.map(stripAnsi);

    expect(rendered).toContain("  $ set -euo pipefail");
    expect(rendered).toContain("  $ WID=$(xdotool search --name 'QEMU \\(exo-windows\\)' | head -n1)");
    expect(rendered).toContain('  $ xdotool windowactivate --sync "$WID"');
    expect(rendered).toContain("  VM screenshot windows --out /home/yeyito/Workspace/virtual-machines/windows/logs/spice-driver-x11click3.png");
    expect(rendered).toContain("  $ ls -l /home/yeyito/Workspace/virtual-machines/windows/logs/spice-driver-x11click3.png --timeout 240000");
  });

  test("does not style external-tool names that appear inside heredoc bodies during linewise bash rendering", () => {
    const state = {
      messages: [{
        role: "assistant",
        blocks: [{
          type: "tool_call",
          toolCallId: "1",
          toolName: "bash",
          input: {},
          summary: [
            "cat > /tmp/vm-script.sh <<'EOF'",
            "vm screenshot windows --out /tmp/not-a-real-call.png",
            "EOF",
            "echo before",
            "vm screenshot windows --out /tmp/real-call.png",
            "echo done",
          ].join("\n"),
        }],
        metadata: null,
      }],
      pendingAI: null,
      toolRegistry: [{ name: "bash", label: "$", color: "#d19a66" }],
      externalToolStyles: [{ cmd: "vm", label: "VM", color: "#7c3aed" }],
      showToolOutput: false,
      convId: null,
      queuedMessages: [],
    } as any;

    const rendered = buildMessageLines(state, 240).lines.map(stripAnsi);

    expect(rendered).not.toContain("  VM screenshot windows --out /tmp/not-a-real-call.png");
    expect(rendered).toContain("  $ cat > /tmp/vm-script.sh <<'EOF'");
    expect(rendered).toContain("  $ vm screenshot windows --out /tmp/not-a-real-call.png");
    expect(rendered).toContain("  $ echo before");
    expect(rendered).toContain("  VM screenshot windows --out /tmp/real-call.png");
    expect(rendered).toContain("  $ echo done");
  });

  test("keeps later bash commands separate when the first real command is an external tool", () => {
    const state = {
      messages: [{
        role: "assistant",
        blocks: [{
          type: "tool_call",
          toolCallId: "1",
          toolName: "bash",
          input: {},
          summary: [
            "set -euo pipefail",
            "vm keys windows --backend host left ret",
            "sleep 4",
            "vm screenshot windows --out /tmp/vm-host-keys-test.png",
            "ls -l /tmp/vm-host-keys-test.png --timeout 240000",
          ].join("\n"),
        }],
        metadata: null,
      }],
      pendingAI: null,
      toolRegistry: [{ name: "bash", label: "$", color: "#d19a66" }],
      externalToolStyles: [{ cmd: "vm", label: "VM", color: "#7c3aed" }],
      showToolOutput: false,
      convId: null,
      queuedMessages: [],
    } as any;

    const rendered = buildMessageLines(state, 240).lines.map(stripAnsi);

    expect(rendered).toContain("  $ set -euo pipefail");
    expect(rendered).toContain("  VM keys windows --backend host left ret");
    expect(rendered).toContain("  $ sleep 4");
    expect(rendered).toContain("  VM screenshot windows --out /tmp/vm-host-keys-test.png");
    expect(rendered).toContain("  $ ls -l /tmp/vm-host-keys-test.png --timeout 240000");
  });

  test("attaches split parent bash timeout lines after simple external-tool matches", () => {
    const state = {
      messages: [{
        role: "assistant",
        blocks: [{
          type: "tool_call",
          toolCallId: "1",
          toolName: "bash",
          input: {},
          summary: [
            "set -euo pipefail",
            "vm status windows",
            "--timeout 120000",
          ].join("\n"),
        }],
        metadata: null,
      }],
      pendingAI: null,
      toolRegistry: [{ name: "bash", label: "$", color: "#d19a66" }],
      externalToolStyles: [{ cmd: "vm", label: "VM", color: "#7c3aed" }],
      showToolOutput: false,
      convId: null,
      queuedMessages: [],
    } as any;

    const rendered = buildMessageLines(state, 240).lines.map(stripAnsi);

    expect(rendered).toContain("  $ set -euo pipefail");
    expect(rendered).toContain("  VM status windows --timeout 120000");
    expect(rendered).not.toContain("  --timeout 120000");
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

describe("assistant metadata spacing", () => {
  test("suppresses trailing blank assistant lines before committed metadata", () => {
    const state = {
      messages: [{
        role: "assistant",
        blocks: [{
          type: "text",
          text: "Done.\n\n- Commit: 3fb9aa0\n- Message: make context pressure target dynamic at 40% of model max context\n\nPushed to:\n- origin/main\n\n",
        }],
        metadata: { startedAt: 0, endedAt: 12_000, model: "gpt-5.4", tokens: 351 },
      }],
      pendingAI: null,
      toolRegistry: [],
      externalToolStyles: [],
      showToolOutput: false,
      convId: null,
      queuedMessages: [],
    } as any;

    expect(buildMessageLines(state, 120).lines.map(stripAnsi)).toEqual([
      "  Done.",
      "  ",
      "  - Commit: 3fb9aa0",
      "  - Message: make context pressure target dynamic at 40% of model max context",
      "  ",
      "  Pushed to:",
      "  - origin/main",
      "  Gpt-5.4 | 351 tokens | 12s",
    ]);
  });

  test("suppresses trailing blank assistant lines before live metadata", () => {
    const state = {
      messages: [],
      pendingAI: {
        role: "assistant",
        blocks: [{ type: "text", text: "Streaming reply\n\n" }],
        metadata: { startedAt: 0, endedAt: 5_000, model: "gpt-5.4", tokens: 42 },
      },
      toolRegistry: [],
      externalToolStyles: [],
      showToolOutput: false,
      convId: null,
      queuedMessages: [],
    } as any;

    expect(buildMessageLines(state, 120).lines.map(stripAnsi)).toEqual([
      "  Streaming reply",
      "  Gpt-5.4 | 42 tokens | 5s",
    ]);
  });
});

describe("block render cache invalidation", () => {
  test("re-renders a text block when its contents change without changing length", () => {
    const block = { type: "text", text: "abc" };
    const state = {
      messages: [],
      pendingAI: { role: "assistant", blocks: [block], metadata: null },
      toolRegistry: [],
      externalToolStyles: [],
      showToolOutput: false,
      convId: null,
      queuedMessages: [],
    } as any;

    expect(buildMessageLines(state, 80).lines.map(stripAnsi)).toEqual(["  abc"]);

    block.text = "xyz";

    expect(buildMessageLines(state, 80).lines.map(stripAnsi)).toEqual(["  xyz"]);
  });

  test("re-renders a tool result block when its output changes without changing length", () => {
    const block = { type: "tool_result", toolCallId: "call-1", toolName: "read", output: "one", isError: false };
    const state = {
      messages: [{ role: "assistant", blocks: [block], metadata: null }],
      pendingAI: null,
      toolRegistry: [],
      externalToolStyles: [],
      showToolOutput: true,
      convId: null,
      queuedMessages: [],
    } as any;

    expect(buildMessageLines(state, 80).lines.map(stripAnsi)).toEqual(["  ↳ one"]);

    block.output = "two";

    expect(buildMessageLines(state, 80).lines.map(stripAnsi)).toEqual(["  ↳ two"]);
  });
});
