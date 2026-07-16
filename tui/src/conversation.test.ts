import { describe, expect, test } from "bun:test";
import { buildMessageLines, compactionFinishedDivider, compactionSpinnerText, wordWrap } from "./conversation";
import { theme } from "./theme";
import { visibleLength } from "./textwidth";
import { createInitialState } from "./state";
import { CONTEXT_COMPACTION_FINISHED_KIND, CONTEXT_COMPACTION_FINISHED_TEXT, createPendingAI } from "./messages";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("plain word wrapping", () => {
  test("wraps by terminal columns rather than UTF-16 length", () => {
    const wrapped = wordWrap("abc 重音テト音声ライブラリー def", 14);

    expect(wrapped.lines.length).toBeGreaterThan(1);
    expect(wrapped.lines.every(line => visibleLength(line) <= 14)).toBe(true);
  });
});

describe("context compaction status", () => {
  test("renders an animated Compacting status without a synthetic assistant block", () => {
    expect(compactionSpinnerText(1_000, 1_000)).toBe("⠋ Compacting...");
    expect(compactionSpinnerText(1_000, 1_080)).toBe("⠙ Compacting...");

    const state = createInitialState();
    state.pendingAI = createPendingAI(Date.now(), state.model);
    state.pendingAI.blocks.push({ type: "text", text: "Assistant work before compaction\n\n" });
    state.contextCompactionStartedAt = Date.now();
    const rendered = buildMessageLines(state, 100).lines;
    const statusLine = rendered.find((line) => line.includes("Compacting..."));
    const plain = rendered.map(stripAnsi);
    const assistantIndex = plain.findIndex((line) => line.includes("Assistant work before compaction"));
    const statusIndex = plain.findIndex((line) => line.includes("Compacting..."));

    expect(statusLine?.startsWith(`  ${theme.dim}`)).toBe(true);
    expect(statusLine?.endsWith(theme.reset)).toBe(true);
    expect(statusLine?.includes(theme.accent)).toBe(false);
    expect(statusIndex).toBeGreaterThan(assistantIndex);
    expect(plain[statusIndex - 1]).toBe("");
    expect(statusIndex).toBe(plain.length - 1);
  });

  test("renders a persisted completion marker as a half-width markdown divider", () => {
    const state = createInitialState();
    state.messages.push(
      {
        role: "assistant",
        blocks: [{ type: "text", text: "Assistant work before compaction" }],
        metadata: null,
      },
      {
        role: "system",
        text: CONTEXT_COMPACTION_FINISHED_TEXT,
        metadata: {
          startedAt: 2_000,
          endedAt: 2_000,
          model: state.model,
          tokens: 0,
          kind: CONTEXT_COMPACTION_FINISHED_KIND,
        },
      },
    );

    const rendered = buildMessageLines(state, 100).lines;
    const plain = rendered.map(stripAnsi);
    const dividerIndex = plain.findIndex((line) => line.includes("Compaction finished"));

    expect(rendered[dividerIndex].startsWith(`  ${theme.muted}`)).toBe(true);
    expect(plain[dividerIndex]).toBe(`  ${compactionFinishedDivider(100)}`);
    expect(visibleLength(rendered[dividerIndex])).toBe(50);
    expect(plain[dividerIndex - 1]).toBe("");
    expect(plain[dividerIndex + 1]).toBe("");
  });
});

describe("older history loading status", () => {
  test("renders the animated Loading row above the loaded window", () => {
    const state = createInitialState();
    state.historyLoadingOlder = true;
    state.historyLoadingStartedAt = 1_000;
    state.messages.push({ role: "user", text: "recent", metadata: null });

    const rendered = buildMessageLines(state, 80);

    expect(stripAnsi(rendered.lines[0])).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u);
    expect(stripAnsi(rendered.lines[0])).toContain("Loading...");
    expect(rendered.lineAnchors[0]?.segment).toBe("history_loading");
  });

  test("renders the Loading row below pinned system instructions", () => {
    const state = createInitialState();
    state.historyLoadingOlder = true;
    state.historyLoadingStartedAt = 1_000;
    state.messages.push(
      { role: "system_instructions", text: "Follow these rules.", metadata: null },
      { role: "user", text: "recent", metadata: null },
    );

    const rendered = buildMessageLines(state, 80);
    const loadingIndex = rendered.lineAnchors.findIndex((anchor) => anchor.segment === "history_loading");
    const instructionsBottomIndex = rendered.lineAnchors.findIndex((anchor) => anchor.segment === "system_instructions_bottom");

    expect(instructionsBottomIndex).toBeGreaterThanOrEqual(0);
    expect(loadingIndex).toBe(instructionsBottomIndex + 1);
    expect(stripAnsi(rendered.lines[loadingIndex])).toContain("Loading...");
    expect(rendered.lineAnchors[loadingIndex + 1]?.segment).toBe("user_content");
  });
});

describe("queued message rendering", () => {
  test("groups queue display by timing priority while preserving FIFO within each bucket", () => {
    const state = {
      messages: [],
      pendingAI: null,
      toolRegistry: [],
      externalToolStyles: [],
      showToolOutput: false,
      convId: "conv-1",
      queuedMessages: [
        { convId: "conv-1", text: "global idle first", timing: "message-end", source: "global-idle" },
        {
          convId: "conv-1",
          text: "specific idle first",
          timing: "message-end",
          source: "global-idle",
          waitTarget: { type: "conversation", convId: "dependency", label: "Dependency" },
        },
        { convId: "conv-1", text: "message end first", timing: "message-end", source: "daemon" },
        { convId: "conv-1", text: "next turn first", timing: "next-turn", source: "daemon" },
        {
          convId: "conv-1",
          text: "specific idle second",
          timing: "message-end",
          source: "global-idle",
          waitTarget: { type: "folder", folderId: "folder", label: "Folder" },
        },
        { convId: "conv-1", text: "next turn second", timing: "next-turn", source: "daemon" },
        { convId: "conv-1", text: "message end second", timing: "message-end", source: "daemon" },
        { convId: "conv-1", text: "global idle second", timing: "message-end", source: "global-idle" },
      ],
    } as any;

    const rendered = buildMessageLines(state, 80).lines.map(stripAnsi);
    const queuedTextOrder = rendered
      .filter(line => /(?:next turn|message end|specific idle|global idle) (?:first|second)/.test(line))
      .map(line => line.trim());

    expect(queuedTextOrder).toEqual([
      "next turn first",
      "next turn second",
      "message end first",
      "message end second",
      "specific idle first",
      "specific idle second",
      "global idle first",
      "global idle second",
    ]);
  });

  test("uses a distinct label for daemon-owned global idle queue entries", () => {
    const state = {
      messages: [],
      pendingAI: null,
      toolRegistry: [],
      externalToolStyles: [],
      showToolOutput: false,
      convId: "conv-1",
      queuedMessages: [
        { convId: "conv-1", text: "wait for everyone", timing: "message-end", source: "global-idle" },
      ],
    } as any;

    const rendered = buildMessageLines(state, 80).lines.map(stripAnsi);

    expect(rendered.some(line => line.includes("queued: global idle"))).toBe(true);
    expect(rendered.some(line => line.includes("queued: message end"))).toBe(false);
  });

  test("renders queued new-conversation messages in a draft chat", () => {
    const state = {
      messages: [],
      pendingAI: null,
      toolRegistry: [],
      externalToolStyles: [],
      showToolOutput: false,
      convId: null,
      folderInstructionsDoc: null,
      pendingQueuedDraftConvId: "reserved-conv",
      queuedMessages: [
        { convId: "reserved-conv", text: "start a fresh convo", timing: "message-end", source: "global-idle", target: "new-conversation" },
      ],
    } as any;

    const rendered = buildMessageLines(state, 80).lines.map(stripAnsi);

    expect(rendered.some(line => line.includes("start a fresh convo"))).toBe(true);
    expect(rendered.some(line => line.includes("queued: global idle"))).toBe(true);
  });

  test("does not leak queued pending-conversation messages into unrelated blank drafts", () => {
    const state = {
      messages: [],
      pendingAI: null,
      toolRegistry: [],
      externalToolStyles: [],
      showToolOutput: false,
      convId: null,
      folderInstructionsDoc: null,
      pendingQueuedDraftConvId: null,
      queuedMessages: [
        { convId: "pending-conv", text: "belongs elsewhere", timing: "message-end", source: "global-idle", target: "new-conversation" },
      ],
    } as any;

    const rendered = buildMessageLines(state, 80).lines.map(stripAnsi);

    expect(rendered.some(line => line.includes("belongs elsewhere"))).toBe(false);
    expect(rendered.some(line => line.includes("queued: global idle"))).toBe(false);
  });

  test("anchors queued messages below a metadata-only pending assistant turn", () => {
    const state = {
      messages: [
        { role: "user", text: "start work", metadata: null },
      ],
      pendingAI: {
        role: "assistant",
        blocks: [],
        metadata: { startedAt: Date.now(), endedAt: null, tokens: 0, model: "gpt-5.4" },
      },
      pendingAICommittedIndex: null,
      suppressPendingAIMetadataStartedAt: null,
      toolRegistry: [],
      externalToolStyles: [],
      showToolOutput: false,
      convId: "conv-1",
      queuedMessages: [
        { convId: "conv-1", text: "queued voice transcript", timing: "message-end" },
      ],
    } as any;

    const rendered = buildMessageLines(state, 80).lines.map(stripAnsi);
    const pendingMetadataIndex = rendered.findIndex(line => line.includes("0 tokens"));
    const queuedIndex = rendered.findIndex(line => line.includes("queued voice transcript"));

    expect(pendingMetadataIndex).toBeGreaterThan(-1);
    expect(queuedIndex).toBeGreaterThan(pendingMetadataIndex);
  });
});

describe("tool call rendering", () => {
  test("wraps wide-character bash tool calls to the chat width", () => {
    const availableWidth = 162;
    const summary = [
      "cd /home/yeyito/Workspace/research/teto-tts/teto-tts-v3 && OTO=voicebanks/english/重音テト音声ライブラリー/重音テト英語音源/oto.ini; for a in 'E s' 'e s' 's t' 's t-' 'sT' 'st' 't -' 'E -' 'I s' 'i s' 's t' 'u' 'U -' 'n i' 'i t' 'u'; do echo --$a; grep -a \\\"=$a\\\" \\\"$OTO\\\" | head -3; done --timeout 10000",
    ].join("\n");
    const state = {
      messages: [{
        role: "assistant",
        blocks: [{
          type: "tool_call",
          toolCallId: "1",
          toolName: "bash",
          input: {},
          summary,
        }],
        metadata: null,
      }],
      pendingAI: null,
      toolRegistry: [{ name: "bash", label: "$", color: "#d19a66" }],
      externalToolStyles: [],
      showToolOutput: false,
      convId: null,
      queuedMessages: [],
    } as any;

    const rendered = buildMessageLines(state, availableWidth).lines;

    expect(rendered.length).toBeGreaterThan(1);
    expect(rendered.every(line => visibleLength(line) <= availableWidth)).toBe(true);
  });

  test("line-wraps long native Exocortex tool calls without losing their tail", () => {
    const availableWidth = 52;
    const summary = `send: ${"Inspect every relevant file and report the exact behavior. ".repeat(5)}TAIL_SENTINEL --max_depth 2 --mode detach`;
    const state = {
      messages: [{
        role: "assistant",
        blocks: [{
          type: "tool_call",
          toolCallId: "1",
          toolName: "exo",
          input: {},
          summary,
        }],
        metadata: null,
      }],
      pendingAI: null,
      toolRegistry: [{ name: "exo", label: "Exocortex", color: "#1d9bf0" }],
      externalToolStyles: [],
      showToolOutput: false,
      convId: null,
      queuedMessages: [],
    } as any;

    const rendered = buildMessageLines(state, availableWidth).lines.map(stripAnsi);

    expect(rendered.length).toBeGreaterThan(1);
    expect(rendered.every(line => visibleLength(line) <= availableWidth)).toBe(true);
    expect(rendered.some(line => line.includes("TAIL_SENTINEL"))).toBe(true);
    expect(rendered.some(line => line.includes("--max_depth 2"))).toBe(true);
    expect(rendered.some(line => line.includes("--mode detach"))).toBe(true);
    expect(rendered.every(line => !line.includes("…"))).toBe(true);
  });

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

  test("renders computer tool call arguments in the TUI", () => {
    const state = {
      messages: [{
        role: "assistant",
        blocks: [{
          type: "tool_call",
          toolCallId: "1",
          toolName: "computer_click",
          input: { app: "vimbrowser", x: 995, y: 28, mouse_button: "left" },
          summary: "vimbrowser",
        }],
        metadata: null,
      }],
      pendingAI: null,
      toolRegistry: [{ name: "computer_click", label: "Computer", color: "#ff79c6" }],
      externalToolStyles: [],
      showToolOutput: false,
      convId: null,
      queuedMessages: [],
    } as any;

    const rendered = buildMessageLines(state, 120).lines.map(stripAnsi);

    expect(rendered).toContain('  Computer click app="vimbrowser" x=995 y=28 mouse_button="left"');
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

  test("styles external tools after mixed prompt lines and a quote closed on the next line", () => {
    const state = {
      messages: [{
        role: "assistant",
        blocks: [{
          type: "tool_call",
          toolCallId: "1",
          toolName: "bash",
          input: {},
          summary: [
            "$ echo '--- MOM ---' &&",
            "whatsapp messages Mom -n 8 &&",
            "$ echo '",
            "$ --- DAD ---' && whatsapp messages \"Aurelio Linero Archibold\" -n 8 --timeout 120000",
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

    const rendered = buildMessageLines(state, 240).lines.map(stripAnsi);

    expect(rendered).toContain("  $ echo '--- MOM ---' &&");
    expect(rendered).toContain("  WhatsApp messages Mom -n 8 &&");
    expect(rendered).toContain("  $ echo '");
    expect(rendered).toContain("  $ --- DAD ---' &&");
    expect(rendered).toContain('  WhatsApp messages "Aurelio Linero Archibold" -n 8 --timeout 120000');
    expect(rendered).not.toContain("  $ $ echo '");
    expect(rendered).not.toContain("  $ $ --- DAD ---' && whatsapp messages \"Aurelio Linero Archibold\" -n 8 --timeout 120000");
  });

  test("keeps backslash-continued prompt-prefixed external tool args styled as the same tool", () => {
    const state = {
      messages: [{
        role: "assistant",
        blocks: [{
          type: "tool_call",
          toolCallId: "1",
          toolName: "bash",
          input: {},
          summary: [
            "$ gcloud compute instances create ai-assistant-demo \\",
            "$     --zone=europe-west1-b \\",
            "$     --machine-type=e2-micro",
            "$ else",
            "$   echo \"INSTANCE_EXISTS\"",
            "$ fi",
          ].join("\n"),
        }],
        metadata: null,
      }],
      pendingAI: null,
      toolRegistry: [{ name: "bash", label: "$", color: "#d19a66" }],
      externalToolStyles: [{ cmd: "gcloud", label: "GCloud", color: "#4285f4" }],
      showToolOutput: false,
      convId: null,
      queuedMessages: [],
    } as any;

    const rendered = buildMessageLines(state, 240).lines.map(stripAnsi);

    expect(rendered).toContain("  GCloud compute instances create ai-assistant-demo \\");
    expect(rendered).toContain("      --zone=europe-west1-b \\");
    expect(rendered).toContain("      --machine-type=e2-micro");
    expect(rendered).not.toContain("  $     --zone=europe-west1-b \\");
    expect(rendered).not.toContain("  $     --machine-type=e2-micro");
    expect(rendered).toContain("  $ else");
    expect(rendered).toContain('  $   echo "INSTANCE_EXISTS"');
    expect(rendered).toContain("  $ fi");
  });

  test("keeps split parent bash timeout, await, and background args attached to prompt-prefixed external tools", () => {
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
            "$ vm status windows",
            "$  --background",
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
    expect(rendered).toContain("  VM status windows --background");
    expect(rendered).not.toContain("  $  --timeout 120000 --await 30");
    expect(rendered).not.toContain("  $  --background");
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

  test("aggregates metadata for adjacent committed assistant messages without merging messages", () => {
    const state = {
      messages: [
        {
          role: "assistant",
          blocks: [{ type: "text", text: "Initial progress" }],
          metadata: { startedAt: 0, endedAt: 1_000, model: "gpt-5.4", tokens: 10 },
        },
        {
          role: "assistant",
          blocks: [{ type: "text", text: "Final result" }],
          metadata: { startedAt: 3_600_000, endedAt: 7_200_000, model: "gpt-5.4", tokens: 25 },
        },
      ],
      pendingAI: null,
      toolRegistry: [],
      externalToolStyles: [],
      showToolOutput: false,
      convId: null,
      queuedMessages: [],
    } as any;

    expect(buildMessageLines(state, 120).lines.map(stripAnsi)).toEqual([
      "  Initial progress",
      "  Final result",
      "  Gpt-5.4 | 35 tokens | 2h 0m 0s",
    ]);
  });

  test("aggregates metadata across committed assistant messages and live pending assistant", () => {
    const state = {
      messages: [{
        role: "assistant",
        blocks: [{ type: "text", text: "Initial progress" }],
        metadata: { startedAt: 0, endedAt: 1_000, model: "gpt-5.4", tokens: 10 },
      }],
      pendingAI: {
        role: "assistant",
        blocks: [{ type: "text", text: "Still working" }],
        metadata: { startedAt: 3_600_000, endedAt: 7_200_000, model: "gpt-5.4", tokens: 25 },
      },
      toolRegistry: [],
      externalToolStyles: [],
      showToolOutput: false,
      convId: null,
      queuedMessages: [],
    } as any;

    expect(buildMessageLines(state, 120).lines.map(stripAnsi)).toEqual([
      "  Initial progress",
      "  Still working",
      "  Gpt-5.4 | 35 tokens | 2h 0m 0s",
    ]);
  });

  test("aggregates goal metadata across non-contiguous assistant entries through system notices", () => {
    const state = {
      messages: [
        {
          role: "assistant",
          blocks: [{ type: "text", text: "Early compacted goal work" }],
          metadata: { startedAt: 0, endedAt: 60 * 60_000, model: "gpt-5.5", tokens: 1000 },
        },
        { role: "system", text: "[Context warning]", color: undefined, metadata: null },
        {
          role: "assistant",
          blocks: [{ type: "text", text: "Final goal result" }],
          metadata: { startedAt: 85 * 60_000, endedAt: 90 * 60_000, model: "gpt-5.5", tokens: 250 },
        },
      ],
      pendingAI: null,
      goal: {
        objective: "read-only benchmark goal",
        status: "complete",
        createdAt: 5 * 60_000,
        updatedAt: 90 * 60_000,
        turns: 2,
      },
      toolRegistry: [],
      externalToolStyles: [],
      showToolOutput: false,
      convId: null,
      queuedMessages: [],
    } as any;

    expect(buildMessageLines(state, 120).lines.map(stripAnsi)).toEqual([
      "  Early compacted goal work",
      "  Gpt-5.5 | 1,000 tokens | 1h 0m 0s",
      "  [Context warning]",
      "  Final goal result",
      "  Gpt-5.5 | 1,250 tokens | 1h 30m 0s",
    ]);
  });

  test("does not apply completed goal metadata to later unrelated assistant replies", () => {
    const state = {
      messages: [
        {
          role: "assistant",
          blocks: [{ type: "text", text: "Final goal result" }],
          metadata: { startedAt: 0, endedAt: 60 * 60_000, model: "gpt-5.5", tokens: 1000 },
        },
        {
          role: "user",
          text: "new unrelated question",
          metadata: { startedAt: 3 * 60 * 60_000, endedAt: 3 * 60 * 60_000, model: "gpt-5.5", tokens: 0 },
        },
        {
          role: "assistant",
          blocks: [{ type: "text", text: "Unrelated reply" }],
          metadata: { startedAt: 3 * 60 * 60_000, endedAt: 3 * 60 * 60_000 + 5_000, model: "gpt-5.5", tokens: 50 },
        },
      ],
      pendingAI: null,
      goal: {
        objective: "old completed goal",
        status: "complete",
        createdAt: 0,
        updatedAt: 60 * 60_000,
        turns: 1,
      },
      toolRegistry: [],
      externalToolStyles: [],
      showToolOutput: false,
      convId: null,
      queuedMessages: [],
    } as any;

    const rendered = buildMessageLines(state, 120).lines.map(stripAnsi);
    expect(rendered[0]).toBe("  Final goal result");
    expect(rendered[1]).toBe("  Gpt-5.5 | 1,000 tokens | 1h 0m 0s");
    expect(rendered.some((line) => line.includes("new unrelated question"))).toBe(true);
    expect(rendered.slice(-2)).toEqual([
      "  Unrelated reply",
      "  Gpt-5.5 | 50 tokens | 5s",
    ]);
  });

  test("preserves prior goal-span display after a later user message starts a new goal", () => {
    const state = {
      messages: [
        {
          role: "assistant",
          blocks: [{ type: "text", text: "Old goal early work" }],
          metadata: { startedAt: 0, endedAt: 60 * 60_000, model: "gpt-5.5", tokens: 1000 },
        },
        { role: "system", text: "[Context warning]", color: undefined, metadata: null },
        {
          role: "assistant",
          blocks: [{ type: "text", text: "Old goal final result" }],
          metadata: { startedAt: 115 * 60_000, endedAt: 120 * 60_000, model: "gpt-5.5", tokens: 250 },
        },
        {
          role: "user",
          text: "why did you stop?",
          metadata: { startedAt: 180 * 60_000, endedAt: 180 * 60_000, model: "gpt-5.5", tokens: 0 },
        },
        {
          role: "assistant",
          blocks: [{ type: "text", text: "New goal restarted" }],
          metadata: { startedAt: 180 * 60_000, endedAt: 180 * 60_000 + 5_000, model: "gpt-5.5", tokens: 50 },
        },
      ],
      pendingAI: null,
      goal: {
        objective: "new active goal that replaced the old completed goal record",
        status: "active",
        createdAt: 180 * 60_000,
        updatedAt: 180 * 60_000 + 5_000,
        turns: 1,
      },
      toolRegistry: [],
      externalToolStyles: [],
      showToolOutput: false,
      convId: null,
      queuedMessages: [],
    } as any;

    const rendered = buildMessageLines(state, 120).lines.map(stripAnsi);
    expect(rendered).toContain("  Gpt-5.5 | 1,250 tokens | 2h 0m 0s");
    expect(rendered.slice(-2)).toEqual([
      "  New goal restarted",
      "  Gpt-5.5 | 50 tokens | 5s",
    ]);
  });

  test("ignores overbroad legacy summary metadata instead of rendering idle days", () => {
    const state = {
      messages: [
        {
          role: "assistant",
          blocks: [{ type: "text", text: "[Summary of turns 10–100]\nLegacy summary" }],
          metadata: { startedAt: 0, endedAt: 4 * 24 * 60 * 60_000, model: "gpt-5.5", tokens: 47_507 },
        },
        {
          role: "assistant",
          blocks: [{ type: "text", text: "Current work" }],
          metadata: { startedAt: 4 * 24 * 60 * 60_000 + 2 * 60_000, endedAt: 4 * 24 * 60 * 60_000 + 10 * 60_000, model: "gpt-5.5", tokens: 12_788 },
        },
      ],
      pendingAI: null,
      toolRegistry: [],
      externalToolStyles: [],
      showToolOutput: false,
      convId: null,
      queuedMessages: [],
    } as any;

    expect(buildMessageLines(state, 120).lines.map(stripAnsi)).toEqual([
      "  [Summary of turns 10–100]",
      "  Legacy summary",
      "  Current work",
      "  Gpt-5.5 | 12,788 tokens | 8m 0s",
    ]);
  });

  test("does not aggregate assistant metadata across large idle gaps when compaction hid boundaries", () => {
    const state = {
      messages: [
        {
          role: "assistant",
          blocks: [{ type: "text", text: "Old short reply" }],
          metadata: { startedAt: 0, endedAt: 30_000, model: "gpt-5.5", tokens: 150 },
        },
        {
          role: "assistant",
          blocks: [{ type: "text", text: "Current work" }],
          metadata: { startedAt: 4 * 24 * 60 * 60_000, endedAt: 4 * 24 * 60 * 60_000 + 8 * 60_000, model: "gpt-5.5", tokens: 12_788 },
        },
      ],
      pendingAI: null,
      toolRegistry: [],
      externalToolStyles: [],
      showToolOutput: false,
      convId: null,
      queuedMessages: [],
    } as any;

    expect(buildMessageLines(state, 120).lines.map(stripAnsi)).toEqual([
      "  Old short reply",
      "  Current work",
      "  Gpt-5.5 | 12,788 tokens | 8m 0s",
    ]);
  });
});

describe("system message rendering", () => {
  test("preserves ANSI-decorated heatmap rows without breaking escape sequences", () => {
    const state = {
      messages: [{
        role: "system",
        text: `Heatmap\n  Su  ${theme.accent}■${theme.reset}${theme.dim} ${theme.muted}■${theme.reset}${theme.dim}`,
        color: undefined,
      }],
      pendingAI: null,
      toolRegistry: [],
      externalToolStyles: [],
      showToolOutput: false,
      convId: null,
      queuedMessages: [],
    } as any;

    const rendered = buildMessageLines(state, 20).lines;
    expect(rendered).toHaveLength(2);
    expect(stripAnsi(rendered[0])).toBe("  Heatmap");
    expect(stripAnsi(rendered[1])).toBe("    Su  ■ ■");
  });
});

describe("terminal control sanitization", () => {
  test("normalizes carriage-return tool output into safe wrapped lines", () => {
    const state = {
      messages: [{
        role: "assistant",
        blocks: [{
          type: "tool_result",
          toolCallId: "1",
          toolName: "bash",
          output: "% Total % Received % Xferd Time\r0 173.6k 0\r/home/yeyito/.local/share",
          isError: false,
        }],
        metadata: null,
      }],
      pendingAI: null,
      toolRegistry: [],
      externalToolStyles: [],
      showToolOutput: true,
      convId: null,
      queuedMessages: [],
    } as any;

    expect(buildMessageLines(state, 120).lines.map(stripAnsi)).toEqual([
      "  ↳ % Total % Received % Xferd Time",
      "    0 173.6k 0",
      "    /home/yeyito/.local/share",
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
