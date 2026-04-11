import { describe, expect, test } from "bun:test";
import { resolveToolDisplay, resolveBashExternalMatch } from "./toolstyles";
import type { ExternalToolStyle, ToolDisplayInfo } from "./messages";

const registry: ToolDisplayInfo[] = [
  { name: "bash", label: "$", color: "#d19a66" },
];

const externalToolStyles: ExternalToolStyle[] = [
  { cmd: "exo", label: "Exocortex", color: "#1d9bf0" },
  { cmd: "gmail", label: "Gmail", color: "#4ddbb7" },
  { cmd: "whatsapp", label: "WhatsApp", color: "#25d366" },
];

describe("bash external tool styling", () => {
  test("matches direct external tool invocation", () => {
    const display = resolveToolDisplay("bash", "exo status --json", registry, externalToolStyles);

    expect(display.label).toBe("Exocortex");
    expect(display.detail).toBe("status --json");
    expect(display.cmd).toBe("exo");
  });

  test("matches through setup-line prelude", () => {
    const summary = "set -euo pipefail\ncd /home/yeyito/Workspace/Exocortex/daemon\nexo status --json";
    const display = resolveToolDisplay("bash", summary, registry, externalToolStyles);
    const match = resolveBashExternalMatch(summary, externalToolStyles);

    expect(display.label).toBe("Exocortex");
    expect(display.detail).toBe("status --json");
    expect(display.cmd).toBe("exo");
    expect(match).toMatchObject({
      lines: [
        "set -euo pipefail",
        "cd /home/yeyito/Workspace/Exocortex/daemon",
        "exo status --json",
      ],
      matchLineIndex: 2,
      matchStart: 0,
    });
  });

  test("matches after same-line setup command chained with &&", () => {
    const summary = "cd /home/yeyito/Workspace/Exocortex/external-tools/exo-cli && exo --help --timeout 120000";
    const display = resolveToolDisplay("bash", summary, registry, externalToolStyles);
    const match = resolveBashExternalMatch(summary, externalToolStyles);

    expect(display.label).toBe("Exocortex");
    expect(display.detail).toBe("--help --timeout 120000");
    expect(display.cmd).toBe("exo");
    expect(match).toMatchObject({
      lines: [summary],
      matchLineIndex: 0,
      matchStart: summary.indexOf("exo --help"),
    });
  });

  test("matches through leading comments and export lines", () => {
    const display = resolveToolDisplay(
      "bash",
      "# check mailbox\nexport FOO=1\ngmail search --query from:alice",
      registry,
      externalToolStyles,
    );

    expect(display.label).toBe("Gmail");
    expect(display.detail).toBe("search --query from:alice");
    expect(display.cmd).toBe("gmail");
  });

  test("matches after cat heredoc prelude that writes a temp file", () => {
    const summary = [
      "cat > /tmp/kittenml-reply.txt <<'EOF'",
      "Hi!",
      "EOF",
      "",
      "gmail reply -f /tmp/kittenml-reply.txt 19d68e0c3d19ece3 --timeout 120000",
    ].join("\n");
    const display = resolveToolDisplay("bash", summary, registry, externalToolStyles);
    const match = resolveBashExternalMatch(summary, externalToolStyles);

    expect(display.label).toBe("Gmail");
    expect(display.detail).toBe("reply -f /tmp/kittenml-reply.txt 19d68e0c3d19ece3 --timeout 120000");
    expect(display.cmd).toBe("gmail");
    expect(match).toMatchObject({ matchLineIndex: 4, matchStart: 0 });
  });

  test("matches through inline assignments and transparent wrappers", () => {
    const summary = "env FOO=1 command time exo ls | sed -n '1,5p'";
    const display = resolveToolDisplay("bash", summary, registry, externalToolStyles);
    const match = resolveBashExternalMatch(summary, externalToolStyles);

    expect(display.label).toBe("Exocortex");
    expect(display.detail).toBe("ls | sed -n '1,5p'");
    expect(display.cmd).toBe("exo");
    expect(match).toMatchObject({ matchLineIndex: 0, matchStart: 23 });
  });

  test("matches external tool when the first line ends inside a multiline quoted argument", () => {
    const summary = [
      'whatsapp send Mom "Hola ma, update rápido 🙏',
      '',
      'Ya nos sirvió mucho lo que mandaste por email:',
      '- ✅ la referencia bancaria de Banco General',
      'Gracias 💙"',
    ].join("\n");
    const display = resolveToolDisplay("bash", summary, registry, externalToolStyles);
    const match = resolveBashExternalMatch(summary, externalToolStyles);

    expect(display.label).toBe("WhatsApp");
    expect(display.detail).toBe('send Mom "Hola ma, update rápido 🙏\n\nYa nos sirvió mucho lo que mandaste por email:\n- ✅ la referencia bancaria de Banco General\nGracias 💙"');
    expect(display.cmd).toBe("whatsapp");
    expect(match).toMatchObject({ matchLineIndex: 0, matchStart: 0 });
  });

  test("falls back to plain bash when another real command comes first", () => {
    const summary = "git fetch\nexo status --json";
    const display = resolveToolDisplay("bash", summary, registry, externalToolStyles);

    expect(display.label).toBe("$");
    expect(display.detail).toBe(summary);
    expect(display.cmd).toBeUndefined();
  });

  test("falls back to plain bash when another same-line command comes first", () => {
    const summary = "git fetch && exo status --json";
    const display = resolveToolDisplay("bash", summary, registry, externalToolStyles);

    expect(display.label).toBe("$");
    expect(display.detail).toBe(summary);
    expect(display.cmd).toBeUndefined();
  });

  test("falls back to plain bash for command -v introspection", () => {
    const summary = "command -v exo";
    const display = resolveToolDisplay("bash", summary, registry, externalToolStyles);

    expect(display.label).toBe("$");
    expect(display.detail).toBe(summary);
    expect(display.cmd).toBeUndefined();
  });
});
