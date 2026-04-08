/**
 * Tool style resolution.
 *
 * Resolves tool display data for rendering. Uses daemon-provided
 * registry for built-in tools and daemon-provided external tool
 * styles for bash sub-command matching (e.g. "gmail" → Gmail).
 *
 * External tool styles are sent by the daemon on connect (and
 * re-broadcast when tools are added/removed at runtime).
 */

import type { ToolDisplayInfo, ExternalToolStyle } from "./messages";
import { theme, hexToAnsi } from "./theme";

// ── Types ──────────────────────────────────────────────────────────

export interface ResolvedToolDisplay {
  label: string;
  detail: string;
  fg: string;     // ANSI truecolor escape
  /** Original command prefix that matched (external tools only). Used for multi-line re-application. */
  cmd?: string;
}

export interface BashExternalMatch {
  /** Full bash summary split into display lines (leading top-level whitespace trimmed). */
  lines: string[];
  /** Line index containing the first matched external command. */
  matchLineIndex: number;
  /** Character offset inside lines[matchLineIndex] where the external command starts. */
  matchStart: number;
  /** Resolved external-tool display. */
  display: ResolvedToolDisplay;
}

interface ShellToken {
  text: string;
  start: number;
}

interface CommandCandidate {
  lines: string[];
  matchLineIndex: number;
  matchStart: number;
  candidate: string;
}

// ── External tool matching ────────────────────────────────────────

const SETUP_COMMANDS = new Set(["set", "cd", "export", "unset", "source", "."]);

/** Shell assignment word (NAME=value). */
function isAssignmentWord(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

/**
 * Minimal shell-ish tokenizer for a single command line.
 *
 * This is intentionally not a full shell parser. It only needs to
 * recover token boundaries and the start offset of the first real
 * executable after common wrappers / setup.
 */
function tokenizeShellWords(line: string): ShellToken[] | null {
  const tokens: ShellToken[] = [];
  let i = 0;

  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;

    const start = i;
    let text = "";

    while (i < line.length && !/\s/.test(line[i])) {
      const ch = line[i];

      if (ch === "'") {
        i++;
        while (i < line.length && line[i] !== "'") {
          text += line[i];
          i++;
        }
        if (i >= line.length) return null;
        i++;
        continue;
      }

      if (ch === '"') {
        i++;
        while (i < line.length && line[i] !== '"') {
          if (line[i] === "\\" && i + 1 < line.length) i++;
          text += line[i];
          i++;
        }
        if (i >= line.length) return null;
        i++;
        continue;
      }

      if (ch === "\\" && i + 1 < line.length) {
        i++;
        text += line[i];
        i++;
        continue;
      }

      text += ch;
      i++;
    }

    tokens.push({ text, start });
  }

  return tokens;
}

function stripLeadingAssignments(tokens: ShellToken[], start = 0): number {
  let i = start;
  while (i < tokens.length && isAssignmentWord(tokens[i].text)) i++;
  return i;
}

function unwrapEnv(tokens: ShellToken[], start: number): number | null {
  let i = start + 1;

  while (i < tokens.length) {
    const t = tokens[i].text;
    if (t === "--") {
      i++;
      break;
    }
    if (!t.startsWith("-")) break;
    i++;
  }

  i = stripLeadingAssignments(tokens, i);
  return i < tokens.length ? i : null;
}

function unwrapCommand(tokens: ShellToken[], start: number): number | null {
  let i = start + 1;
  let introspectionOnly = false;

  while (i < tokens.length && tokens[i].text.startsWith("-")) {
    const t = tokens[i].text;
    if (/^-[^-]*[vV]/.test(t)) introspectionOnly = true;
    i++;
  }

  if (introspectionOnly || i >= tokens.length) return null;
  return i;
}

function unwrapTime(tokens: ShellToken[], start: number): number | null {
  let i = start + 1;
  while (i < tokens.length && tokens[i].text.startsWith("-")) i++;
  return i < tokens.length ? i : null;
}

function unwrapNice(tokens: ShellToken[], start: number): number | null {
  let i = start + 1;

  if (i < tokens.length && tokens[i].text === "-n") {
    i += 2;
  } else if (i < tokens.length && /^-?\d+$/.test(tokens[i].text)) {
    i++;
  }

  return i < tokens.length ? i : null;
}

function unwrapCommandWrappers(tokens: ShellToken[], start: number): number | null {
  let i = stripLeadingAssignments(tokens, start);

  for (;;) {
    if (i >= tokens.length) return null;

    const t = tokens[i].text;
    if (t === "env") {
      const next = unwrapEnv(tokens, i);
      if (next == null) return null;
      i = stripLeadingAssignments(tokens, next);
      continue;
    }
    if (t === "command") {
      const next = unwrapCommand(tokens, i);
      if (next == null) return null;
      i = next;
      continue;
    }
    if (t === "time") {
      const next = unwrapTime(tokens, i);
      if (next == null) return null;
      i = next;
      continue;
    }
    if (t === "nohup") {
      i += 1;
      continue;
    }
    if (t === "nice") {
      const next = unwrapNice(tokens, i);
      if (next == null) return null;
      i = next;
      continue;
    }
    return i;
  }
}

function extractCommandCandidate(summary: string): CommandCandidate | null {
  const lines = summary.trimStart().split("\n");

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const rawLine = lines[lineIndex];
    const trimmedLine = rawLine.trimStart();
    if (!trimmedLine) continue;
    if (trimmedLine.startsWith("#")) continue;

    const tokens = tokenizeShellWords(trimmedLine);
    if (!tokens || tokens.length === 0) return null;

    const firstTokenIndex = stripLeadingAssignments(tokens);
    const firstToken = tokens[firstTokenIndex]?.text;
    if (firstToken && SETUP_COMMANDS.has(firstToken)) continue;

    const commandIndex = unwrapCommandWrappers(tokens, 0);
    if (commandIndex == null) return null;

    const leadingIndent = rawLine.length - trimmedLine.length;
    const matchStart = leadingIndent + tokens[commandIndex].start;
    const rest = lines.slice(lineIndex);
    rest[0] = rawLine.slice(matchStart);
    return {
      lines,
      matchLineIndex: lineIndex,
      matchStart,
      candidate: rest.join("\n").trimStart(),
    };
  }

  return null;
}

/**
 * Try to match a command string against a single external tool style.
 * Returns resolved display if the command starts with the tool's cmd.
 */
function tryMatch(command: string, style: ExternalToolStyle): ResolvedToolDisplay | null {
  const { cmd } = style;
  if (command === cmd || command.startsWith(cmd + " ") || command.startsWith(cmd + "\n")) {
    const detail = command.slice(cmd.length).trimStart();
    return { label: style.label, detail, fg: hexToAnsi(style.color), cmd };
  }
  return null;
}

/**
 * Resolve a bash summary to an external-tool match, including where the
 * external command begins inside the original multi-line summary.
 */
export function resolveBashExternalMatch(summary: string, styles: ExternalToolStyle[]): BashExternalMatch | null {
  if (styles.length === 0) return null;

  const candidate = extractCommandCandidate(summary);
  if (!candidate) return null;

  for (const style of styles) {
    const display = tryMatch(candidate.candidate, style);
    if (display) {
      return {
        lines: candidate.lines,
        matchLineIndex: candidate.matchLineIndex,
        matchStart: candidate.matchStart,
        display,
      };
    }
  }

  return null;
}

/**
 * Match a bash command summary against external tool styles.
 *
 * Looks for the first real executable after skipping obvious shell
 * setup lines (comments, blank lines, set/cd/export/etc.) and a small
 * set of transparent wrappers (env/command/time/nohup/nice).
 */
function matchExternalTool(summary: string, styles: ExternalToolStyle[]): ResolvedToolDisplay | null {
  return resolveBashExternalMatch(summary, styles)?.display ?? null;
}

// ── Resolution ─────────────────────────────────────────────────────

/**
 * Resolve display properties for a tool call.
 *
 * For bash commands, checks external tool styles first (matching the
 * effective executable after setup/wrappers). Falls back to daemon-
 * provided registry, then to a generic default.
 */
export function resolveToolDisplay(
  toolName: string,
  summary: string,
  registry: ToolDisplayInfo[],
  externalToolStyles?: ExternalToolStyle[],
): ResolvedToolDisplay {
  const info = registry.find(t => t.name === toolName);

  if (toolName === "bash" && externalToolStyles) {
    const match = matchExternalTool(summary, externalToolStyles);
    if (match) return match;
  }

  if (info) {
    return {
      label: info.label,
      detail: summary,
      fg: hexToAnsi(info.color),
    };
  }

  return { label: toolName, detail: summary, fg: theme.tool };
}
