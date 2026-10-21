import { describe, expect, test } from "bun:test";
import { renderBlockCached } from "./blockrenderer";
import type { Block, ExternalToolStyle, ToolDisplayInfo } from "./messages";
import { hexToAnsi, theme } from "./theme";
import { renderToolCallLogicalLines, type ToolCallLogicalLine } from "./toolcalllogical";

const registry: ToolDisplayInfo[] = [{ name: "bash", label: "$", color: "#d19a66" }];
const styles: ExternalToolStyle[] = [
  { cmd: "discord", label: "Discord", color: "#5865f2" },
  { cmd: "whatsapp", label: "WhatsApp", color: "#25d366" },
  { cmd: "gmail", label: "Gmail", color: "#4ddbb7" },
];

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function bashCall(command: string, extra: Record<string, unknown> = {}, summarySuffix = ""): Block {
  return { type: "tool_call", toolCallId: "call", toolName: "Bash", input: { command, ...extra }, summary: command + summarySuffix };
}

function rows(block: Block, width = 100, showToolOutput = false): string[] {
  return renderBlockCached(block, width, registry, styles, showToolOutput).lines.map(stripAnsi);
}

function logical(command: string, input: Record<string, unknown> = { command }): ToolCallLogicalLine[] {
  return renderToolCallLogicalLines("bash", command, registry, styles, input);
}

/** Each payload row as [role, kind, language?, owning label]. */
function payloadRows(lines: ToolCallLogicalLine[]): unknown[] {
  return lines.filter(line => line.payload).map(line => [
    line.payload!.role, line.payload!.block.kind, line.payload!.block.language ?? null, line.display.label, line.text,
  ]);
}

const OWNER_REPORT = [
  "D=~/x; cat <<'EOF' | discord -a paramount send 1031060518775038003 -f $D/demo.mp4 2>&1 | tail -1",
  "**Title**",
  "• line one",
  "• line two",
  "EOF",
  "cd ~/y; python3 - <<'EOF'",
  'p="README.md"; s=open(p).read()',
  "EOF",
].join("\n");

describe("heredoc bodies in shell tool calls", () => {
  test("body lines are a payload block, not `$` commands, and the timeout stays out of the command", () => {
    expect(rows(bashCall(OWNER_REPORT, { timeout: 120_000 }, " --timeout_seconds 120"))).toEqual([
      "  $ D=~/x ;  --timeout_seconds 120",
      "  $ cat <<'EOF' |",
      "  Discord -a paramount send 1031060518775038003 -f $D/demo.mp4 2>&1 |",
      "  $ tail -1",
      "    ▎ Discord message",
      "    ▎ Title",
      "    ▎ • line one",
      "    ▎ • line two",
      "    ▎ EOF",
      "  $ cd ~/y; python3 - <<'EOF'",
      '    ▎ p="README.md"; s=open(p).read()',
      "    ▎ EOF",
    ]);
  });

  test("a Discord body is drawn in Discord's colour with its markdown rendered", () => {
    const lines = renderBlockCached(bashCall(OWNER_REPORT), 100, registry, styles, false).lines;
    const title = lines.find(line => stripAnsi(line) === "    ▎ Title")!;
    const discord = hexToAnsi("#5865f2");
    expect(title).toContain(`${discord}${theme.bold}Title`);
    expect(lines.find(line => stripAnsi(line) === "    ▎ Discord message")).toStartWith(`    ${discord}▎ `);
    expect(lines.filter(line => stripAnsi(line).includes("EOF") && stripAnsi(line).includes("▎"))
      .every(line => line.includes(`${theme.dim}EOF`))).toBe(true);
  });

  test("interpreter heredocs are highlighted as their language", () => {
    expect(payloadRows(logical("python3 - <<'EOF'\nprint(1)\nEOF\nbun - <<'TS'\nconst x = 1\nTS\nnode <<JS\nlet y\nJS\nbash -s <<SH\nls\nSH"))).toEqual([
      ["body", "script", "python", "$", "print(1)"],
      ["end", "script", "python", "$", "EOF"],
      ["body", "script", "typescript", "$", "const x = 1"],
      ["end", "script", "typescript", "$", "TS"],
      ["body", "script", "javascript", "$", "let y"],
      ["end", "script", "javascript", "$", "JS"],
      ["body", "script", "bash", "$", "ls"],
      ["end", "script", "bash", "$", "SH"],
    ]);
    // A script file reads the heredoc as data.
    expect(payloadRows(logical("python3 run.py <<EOF\ndata\nEOF"))).toEqual([
      ["body", "text", null, "$", "data"],
      ["end", "text", null, "$", "EOF"],
    ]);
  });

  test("a file written by cat is highlighted by its extension", () => {
    expect(payloadRows(logical("cat > /tmp/fix.py <<'EOF'\nx = 1\nEOF\ncat <<EOF >notes.txt\nhi\nEOF"))).toEqual([
      ["body", "text", "py", "$", "x = 1"],
      ["end", "text", "py", "$", "EOF"],
      ["body", "text", null, "$", "hi"],
      ["end", "text", null, "$", "EOF"],
    ]);
  });

  test("heredocs feeding an external tool belong to it: piped, direct and as a substituted argument", () => {
    const toolOf = (command: string) => payloadRows(logical(command)).map(row => (row as unknown[])[3]);
    expect(toolOf("cat <<'EOF' | discord send 1\nhi\nEOF")).toEqual(["Discord", "Discord", "Discord"]);
    expect(toolOf("whatsapp send Mom <<'EOF'\nhola\nEOF")).toEqual(["WhatsApp", "WhatsApp", "WhatsApp"]);
    expect(toolOf("cat <<EOF | gmail send --to a@b.c\nbody\nEOF")).toEqual(["Gmail", "Gmail", "Gmail"]);
    expect(toolOf(`discord send 1 "$(cat <<'EOF'\nhi\nEOF\n)"`)).toEqual(["Discord", "Discord", "Discord"]);
    expect(toolOf("cat <<EOF |\nhi\nEOF\ndiscord send 1")).toEqual(["Discord", "Discord", "Discord"]);
    // A non-tool command keeps a plain payload.
    expect(toolOf(`git commit -m "$(cat <<'EOF'\nSubject\nEOF\n)"`)).toEqual(["$", "$"]);
  });

  test("message-sending subcommands title the block as a message", () => {
    const titles = (command: string) => logical(command).filter(line => line.payload?.role === "title").map(line => line.text);
    expect(titles("discord -a paramount send 1 <<'EOF'\nhi\nEOF")).toEqual(["Discord message"]);
    expect(titles("gmail draft-import <<'EOF'\nhi\nEOF")).toEqual(["Gmail input"]);
  });

  test("a delimiter look-alike inside the body is body text, never a command", () => {
    const lines = rows(bashCall("whatsapp send Mom <<'EOF'\nEOF is coming\n EOF\nEOF2\nEOF\nls"));
    expect(lines).toEqual([
      "  WhatsApp send Mom <<'EOF'",
      "    ▎ WhatsApp message",
      "    ▎ EOF is coming",
      "    ▎  EOF",
      "    ▎ EOF2",
      "    ▎ EOF",
      "  $ ls",
    ]);
  });

  test("lines that finish a quoted substitution after the body continue its command", () => {
    expect(rows(bashCall(`git commit -m "$(cat <<'EOF'\nSubject\n\nBody\nEOF\n)"\ngit push`))).toEqual([
      `  $ git commit -m "$(cat <<'EOF'`,
      "    ▎ Subject",
      "    ▎ ",
      "    ▎ Body",
      "    ▎ EOF",
      `  )"`,
      "  $ git push",
    ]);
  });

  test("<<- bodies close on their indented delimiter", () => {
    expect(rows(bashCall("if true; then\n\tcat <<-EOF\n\tindented\n\tEOF\nfi"))).toEqual([
      "  $ if true; then",
      "      cat <<-EOF",
      "    ▎     indented",
      "    ▎     EOF",
      "  $ fi",
    ]);
  });

  test("long payloads collapse behind the tool-output toggle; the command never does", () => {
    const body = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const block = bashCall(["cat <<'EOF' | discord send 1", ...body, "EOF", "echo sent"].join("\n"));
    expect(rows(block)).toEqual([
      "  $ cat <<'EOF' |",
      "  Discord send 1",
      "    ▎ Discord message",
      ...body.slice(0, 8).map(line => `    ▎ ${line}`),
      "    ▎ … +12 more lines (ctrl+o to expand)",
      "    ▎ EOF",
      "  $ echo sent",
    ]);
    const expanded = rows(block, 100, true);
    expect(expanded).toHaveLength(2 + 1 + 20 + 1 + 1);
    expect(expanded).toContain("    ▎ line 20");
  });
});

describe("shell call parameters", () => {
  test("show dim after the command's first line instead of glued to its last", () => {
    const lines = renderBlockCached(bashCall("ls -la\necho done", { timeout: 120_000 }, " --timeout_seconds 120"), 100, registry, styles, false).lines;
    expect(lines.map(stripAnsi)).toEqual(["  $ ls -la  --timeout_seconds 120", "  echo done"]);
    expect(lines[0]).toContain(`${theme.dim}--timeout_seconds 120`);
  });

  test("a single-line command keeps them on its row", () => {
    expect(rows(bashCall("gmail search newer_than:1d", { timeout_seconds: 30, background: true }, " --timeout_seconds 30 --background")))
      .toEqual(["  Gmail search newer_than:1d  --timeout_seconds 30 --background"]);
  });

  test("move to their own row when they don't fit", () => {
    expect(rows(bashCall("echo 12345678901234567890", {}, " --timeout_seconds 120"), 30))
      .toEqual(["  $ echo 12345678901234567890", "  --timeout_seconds 120"]);
  });

  test("older history with parameters glued to the closing delimiter still closes the heredoc", () => {
    const summary = "cat <<'EOF' | discord send 1\nhi\nEOF --timeout 120000";
    const lines = renderToolCallLogicalLines("bash", summary, registry, styles, {});
    expect(lines[0].meta).toBe("--timeout 120000");
    expect(payloadRows(lines)).toEqual([
      ["title", "tool", null, "Discord", "Discord message"],
      ["body", "tool", null, "Discord", "hi"],
      ["end", "tool", null, "Discord", "EOF"],
    ]);
  });
});
