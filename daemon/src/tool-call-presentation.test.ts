/**
 * Bash commands from a real Claude Code conversation (Paramount), each mapped
 * to the tools its rendered call shows, end to end: the daemon's per-call
 * presentation snapshot plus the TUI's manifest-name matching. Personal message
 * text is replaced; command shapes, paths, and wrappers are kept verbatim.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { renderToolCallLogicalLines } from "../../tui/src/toolcalllogical";
import type { ExternalToolStyle } from "@exocortex/shared/messages";
import {
  clearToolManifestCacheForTest,
  resolveToolCallPresentation,
  resolveToolCallPresentationFromCache,
  warmToolManifestCache,
} from "./helper-tool-manifest";

// External tools render by their manifest name on PATH (getExternalToolStyles()).
const PATH_STYLES: ExternalToolStyle[] = [
  { cmd: "cal", label: "Calendar", color: "#1d9bf0" },
  { cmd: "discord", label: "Discord", color: "#5865F2" },
  { cmd: "exo", label: "Exocortex CLI", color: "#1d9bf0" },
  { cmd: "gmail", label: "Gmail", color: "#4ddbb7" },
  { cmd: "secrets", label: "Secrets", color: "#b779ff" },
  { cmd: "vimbrowser-cli", label: "Vimbrowser", color: "#48c9e3" },
  { cmd: "whatsapp", label: "WhatsApp", color: "#25d366" },
];
const REGISTRY = [{ name: "bash", label: "Bash", color: "#ffffff" }];

let home = "";
let repo = "";
let cwd = "";

function writeExecutable(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 });
}

/** An external tool in the TOOL_STANDARD layout: manifest.json + bin/<name>. */
function addExternalTool(dir: string, name: string, label: string, color: string): void {
  writeExecutable(join(dir, "bin", name));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    name, bin: `./bin/${name}`, systemHint: "", display: { label, color },
  }));
}

/** A helper tool: executable beside exo-manifest.json. */
function addHelperTool(dir: string, name: string, label: string, color: string): void {
  writeExecutable(join(dir, name));
  writeFileSync(join(dir, "exo-manifest.json"), JSON.stringify({ version: 1, display: { label, color } }));
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "exocortex-presentation-"));
  repo = join(home, "Workspace", "exocortex");
  cwd = join(repo, "config", "data", "workspaces", "conversation");
  mkdirSync(cwd, { recursive: true });
  addExternalTool(join(repo, "external-tools", "gmail-cli"), "gmail", "Gmail", "#4ddbb7");
  addExternalTool(join(repo, "external-tools", "discord-cli"), "discord", "Discord", "#5865F2");
  addExternalTool(join(repo, "external-tools", "exo-cli"), "exo", "Exocortex CLI", "#1d9bf0");
  addHelperTool(join(repo, "helper-tools", "quercus"), "quercus", "Quercus", "#E4572E");
  addHelperTool(join(repo, "helper-tools", "utmail"), "utmail", "UTmail", "#0078d4");
  // A CLI-shaped helper tool: full manifest one level above bin/.
  addExternalTool(join(repo, "helper-tools", "vm-cli"), "vm", "VM", "#b03a5b");
  // An unrelated executable sharing a tool's name.
  writeExecutable(join(home, "usr", "bin", "cal"));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

/** The real conversation ran in /home/yeyito; the fixture home stands in for it. */
function localize(command: string): string {
  return command.replaceAll("/home/yeyito", home);
}

async function renderedTools(command: string): Promise<string[]> {
  const local = localize(command);
  const presentation = await resolveToolCallPresentation("Bash", { command: local }, cwd, home);
  const styles = [...(presentation?.bashStyles ?? []), ...PATH_STYLES];
  const lines = renderToolCallLogicalLines("Bash", local, REGISTRY, styles, { command: local });
  return [...new Set(lines.map((line) => line.display.label))].filter((label) => label !== "Bash");
}

const X = "/home/yeyito/Workspace/exocortex";

/** [command, tools shown in order of first appearance; [] = plain Bash]. */
const CASES: Array<[string, string[]]> = [
  // Absolute paths to external and helper tools.
  [`${X}/external-tools/gmail-cli/bin/gmail read 1a12bd2c7de93d72 2>&1 | head -14`, ["Gmail"]],
  [`~/Workspace/exocortex/external-tools/exo-cli/bin/exo transcribe /tmp/vm-1641/voice-message.ogg --mime-type audio/ogg 2>&1 | tail -15`, ["Exocortex CLI"]],
  [`${X}/helper-tools/vm-cli/bin/vm status`, ["VM"]],
  // Variable indirection.
  [`G=${X}/external-tools/gmail-cli/bin/gmail; $G search "newer_than:1d -category:promotions -category:social" --limit 30 2>&1 | cut -c1-170`, ["Gmail"]],
  [`D=${X}/external-tools/discord-cli/bin/discord; $D -a paramount messages 1031060518775038003 -n 25 2>&1 | tail -40 | cut -c1-300`, ["Discord"]],
  [`Q=~/Workspace/exocortex/helper-tools/quercus/quercus; $Q courses 2>&1 | head -12`, ["Quercus"]],
  [`U=~/Workspace/exocortex/helper-tools/utmail/utmail; timeout 120 $U show "AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0Aw98aQW-Zl0y16ZB3ojoFDQAASevRogAA" 2>&1 | sed '/^\\s*$/d' | sed -n 1,40p | cut -c1-250`, ["UTmail"]],
  [`Q=$(command -v quercus || echo ${X}/helper-tools/quercus/quercus); timeout 60 $Q announcements ECO101 --since 10h -n 5 --json 2>&1 | head -c 800`, ["Quercus"]],
  // Variables in loops, with multi-line quoted scripts piped after them.
  [`Q=${X}/helper-tools/quercus/quercus; for c in 443485 445723; do $Q assignments $c --bucket upcoming --limit 30 --json 2>&1 | python3 -c "\nimport json,sys\nd=json.load(sys.stdin)\nprint('$c', len(d))\n"; done`, ["Quercus"]],
  // Heredoc bodies are data; the command reading them is still the tool.
  [`D=${X}/external-tools/discord-cli/bin/discord\n$D typing -a paramount 1492179045167796224 --for 4 >/dev/null 2>&1\n$D send -a paramount 1492179045167796224 <<'EOF'\nlanded the fix\n- notes line\nEOF`, ["Discord"]],
  [`cat > /tmp/followup.txt <<'EOF'\nHi team,\n\nfollowing up.\nEOF\n${X}/external-tools/gmail-cli/bin/gmail reply 1a0dfc53a9ed9cf0 < /tmp/followup.txt 2>&1 | tail -3`, ["Gmail"]],
  // Relative paths after `cd /absolute &&`, including into compound commands.
  [`cd ~/Workspace/exocortex && timeout 120 helper-tools/utmail/utmail inbox --since 14h 2>&1 | head -60`, ["UTmail"]],
  [`cd ~/Workspace/exocortex/external-tools/discord-cli && ./bin/discord notify -h 2>&1 | head -40; grep -n "filter" src/exocortex.py | head -30`, ["Discord"]],
  [`cd ~/Workspace/exocortex && for c in 443485 445723; do timeout 90 helper-tools/quercus/quercus announcements $c --since 16h --json 2>&1 | python3 -c "\nimport json,sys\nprint(len(json.load(sys.stdin)))\n"; done`, ["Quercus"]],
  [`for t in 831 832 833; do vimbrowser-cli close-tab $t >/dev/null 2>&1; done; cd ~/Workspace/exocortex && timeout 150 helper-tools/utmail/utmail inbox --since 16h 2>&1 | head -40`, ["Vimbrowser", "UTmail"]],
  // Bare names on PATH, inside loops.
  [`for id in 389addbb-4f41-4567-b971-cf041ad194f3 3316014a-6876-4c40-a41b-60804a87844f; do cal event complete $id 2>&1 | tail -1; done; printf '%s\\n' "- note" >> ~/Documents/notes.md`, ["Calendar"]],
  [`whatsapp send -h 2>&1 | head -15`, ["WhatsApp"]],
  [`secrets run --allow UOFT_UTORID -- python3 -I -c 'print(1)'`, ["Secrets"]],
  // Not tool calls: mentions, interpreters, substitutions, other tools' names.
  [`cd ~/Documents/UofT/reminders && wc -l COORDINATOR_POLICY.md && grep -n -i -E "quercus|utmail|deadline" COORDINATOR_POLICY.md`, []],
  [`python3 - <<'EOF'\nimport json,subprocess\nQ="${X}/helper-tools/quercus/quercus"\nprint(subprocess.run([Q,"courses"]).returncode)\nEOF`, []],
  [`cd ${X}/helper-tools/utmail; grep -rn -i "getenv" src | head -10`, []],
  [`type -a gmail; ls ${X}/external-tools/gmail-cli/bin/`, []],
  [`cd ~/Workspace/exocortex && ID=$(timeout 120 helper-tools/utmail/utmail inbox --since 9h --json 2>/dev/null | head -1); echo $ID`, []],
  [`CLAUDE_CONFIG_DIR=~/.claude-max2 claude -p hi`, []],
  [`cat <<'EOF'\n${X}/external-tools/gmail-cli/bin/gmail read 1\nEOF`, []],
  [`echo ${X}/external-tools/gmail-cli/bin/gmail`, []],
  [`/home/yeyito/usr/bin/cal 2026`, []],
  [`G=${X}/external-tools/gmail-cli/bin/gmail; G=${X}/external-tools/discord-cli/bin/discord; $G search x`, []],
  [`for G in ${X}/external-tools/gmail-cli/bin/gmail; do $G search x; done`, []],
  [`G=${X}/external-tools/gmail-cli/bin/gmail; '$G' search x`, []],
  [`$HOME/Workspace/exocortex/external-tools/gmail-cli/bin/gmail read 1`, []],
  [`cd ~/Workspace/exocortex; helper-tools/utmail/utmail inbox`, []],
  [`cd ~/Workspace/exocortex && true; helper-tools/utmail/utmail inbox`, []],
];

describe("tool-call presentation of real Bash commands", () => {
  test.each(CASES)("%s", async (command, expected) => {
    expect(await renderedTools(command)).toEqual(expected);
  });

  test("Claude Code's synchronous presenter answers from warmed manifests", async () => {
    clearToolManifestCacheForTest();
    const command = localize(`G=${X}/external-tools/gmail-cli/bin/gmail; $G search x`);
    expect(resolveToolCallPresentationFromCache("Bash", { command }, cwd, home)).toBeUndefined();

    await warmToolManifestCache([join(repo, "external-tools"), join(repo, "helper-tools")]);
    expect(resolveToolCallPresentationFromCache("Bash", { command }, cwd, home)).toEqual({
      bashStyles: [{ cmd: "$G", label: "Gmail", color: "#4ddbb7" }],
    });
    expect(resolveToolCallPresentationFromCache("Read", { command }, cwd, home)).toBeUndefined();
  });

  test("Codex exec_command calls resolve like Bash", async () => {
    const cmd = localize(`${X}/helper-tools/quercus/quercus courses`);
    expect(await resolveToolCallPresentation("exec_command", { cmd }, cwd, home)).toEqual({
      bashStyles: [{ cmd: localize(`${X}/helper-tools/quercus/quercus`), label: "Quercus", color: "#E4572E" }],
    });
  });
});
