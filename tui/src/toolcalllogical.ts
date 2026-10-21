/**
 * Tool-call logical line rendering.
 *
 * This module owns the heuristics for presenting tool calls, especially bash
 * transcripts that can contain prompts, setup commands, heredocs, shell
 * continuations, and embedded external tool invocations. Keeping this out of
 * conversation.ts leaves the main conversation builder focused on message flow
 * and anchoring instead of shell-transcript parsing.
 */

import type { ExternalToolStyle, ToolDisplayInfo } from "./messages";
import {
  resolveBashExternalMatch,
  resolveToolDisplay,
  shellCommandWords,
  type BashExternalMatch,
  type ResolvedToolDisplay,
} from "./toolstyles";
import {
  splitTopLevelShellSegments,
  splitTopLevelShellSegmentsWithState,
  type ShellQuoteState,
} from "./bashsegments";
import {
  hasHeredocPiece,
  isHeredocDelimiterLine,
  scanHeredocOperators,
  splitHeredocPieces,
  type CommandPiece,
  type HeredocPiece,
} from "./bashheredocs";
import { isLanguageSupported } from "./markdown/highlight";
import { sanitizeUntrustedText } from "./terminaltext";

export interface ToolCallLogicalLine {
  display: ResolvedToolDisplay;
  text: string;
  hasLabel: boolean;
  /** Call parameters shown dim after this line (`--timeout_seconds 120`). */
  meta?: string;
  /** Set on the rows of a heredoc or stdin payload block. */
  payload?: { block: ToolCallPayload; role: "title" | "body" | "end" };
}

/**
 * Data a shell command feeds to a program: a heredoc body or the call's
 * literal stdin. Its rows render as an indented block, not as commands.
 */
export interface ToolCallPayload {
  /** `tool`: input to an external tool, drawn in its colour; `script`/`text`: dim or highlighted code. */
  kind: "tool" | "script" | "text";
  /** Syntax-highlighting language for scripts and files with a known extension. */
  language?: string;
  /** Render light markdown (the receiving tool shows it formatted). */
  markdown?: boolean;
}

interface SegmentedBashRenderOptions {
  requirePrompts: boolean;
  stripPromptPrefix: boolean;
  allowSimpleExternalLines?: boolean;
}

interface PendingHeredoc {
  terminator: string;
  allowTabs: boolean;
}

interface PendingExternalCommand {
  display: ResolvedToolDisplay;
  state: ShellCommandContinuationState;
}

interface ShellCommandContinuationState {
  quote: ShellQuoteState;
  pendingHeredocs: PendingHeredoc[];
  lineContinuation: boolean;
}

interface BashStdinLineRange {
  /** Line containing the start of the daemon-appended `--stdin` value. */
  startLineIndex: number;
  /** Last line touched by that value, including a line created by a trailing newline. */
  endLineIndex: number;
}

/**
 * Locate physical lines introduced by bash's synthetic `--stdin <value>`
 * summary argument. They are data, not additional shell commands, so the
 * renderer must not run its usual linewise command detection over them.
 */
function bashStdinLineRange(
  summary: string,
  toolInput: Record<string, unknown> | undefined,
): BashStdinLineRange | null {
  if (typeof toolInput?.stdin !== "string") return null;

  const stdin = sanitizeUntrustedText(toolInput.stdin);
  if (!stdin.includes("\n")) return null;

  const source = summary.trimStart();
  const prefix = "--stdin ";
  const markerStart = source.lastIndexOf(`${prefix}${stdin}`);
  if (markerStart < 0) return null;

  const valueStart = markerStart + prefix.length;
  const startLineIndex = (source.slice(0, valueStart).match(/\n/g) ?? []).length;
  return {
    startLineIndex,
    endLineIndex: startLineIndex + (stdin.match(/\n/g) ?? []).length,
  };
}

function isBashStdinContinuationLine(range: BashStdinLineRange | null, lineIndex: number): boolean {
  return !!range && lineIndex > range.startLineIndex && lineIndex <= range.endLineIndex;
}

function isPromptedBashTranscript(summary: string): boolean {
  const lines = summary.trimStart().split("\n");
  let sawPrompt = false;

  for (const line of lines) {
    if (!line.trim()) continue;
    if (!line.trimStart().startsWith("$ ")) return false;
    sawPrompt = true;
  }

  return sawPrompt;
}

function stripPromptPrefixIfPresent(line: string, enabled: boolean): string {
  if (!enabled) return line;

  const trimmed = line.trimStart();
  return trimmed.startsWith("$ ") ? trimmed.slice(2) : line;
}

function pushLogicalLine(logical: ToolCallLogicalLine[], display: ResolvedToolDisplay, detail: string, hasLabel: boolean): void {
  logical.push({
    display,
    text: hasLabel ? (detail ? `${display.label} ${detail}` : display.label) : detail,
    hasLabel,
  });
}

function pushCommandDetail(logical: ToolCallLogicalLine[], display: ResolvedToolDisplay): void {
  if (!display.cmd || !display.detail) {
    pushLogicalLine(logical, display, display.detail, true);
    return;
  }

  const cmd = display.cmd;
  for (const [i, line] of display.detail.split("\n").entries()) {
    if (i === 0) {
      pushLogicalLine(logical, display, line, true);
      continue;
    }

    const t = line.trimStart();
    if (t === cmd || t.startsWith(cmd + " ")) {
      const args = t.slice(cmd.length).trimStart();
      pushLogicalLine(logical, display, args, true);
    } else {
      pushLogicalLine(logical, display, line, false);
    }
  }
}

function appendMatchedBashSegment(
  logical: ToolCallLogicalLine[],
  bashDisplay: ResolvedToolDisplay,
  text: string,
  match: BashExternalMatch | null,
): void {
  if (match && match.matchLineIndex === 0) {
    const prefix = match.lines[0]?.slice(0, match.matchStart).trimEnd() ?? "";
    if (prefix.trim()) pushLogicalLine(logical, bashDisplay, prefix, true);
    pushCommandDetail(logical, match.display);
    return;
  }

  pushLogicalLine(logical, bashDisplay, text, true);
}

function isParentBashOptionContinuation(text: string): boolean {
  const tokens = text.trimStart().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;

  for (let i = 0; i < tokens.length;) {
    if (tokens[i] === "--background") {
      i += 1;
      continue;
    }
    if (tokens[i] !== "--timeout" && tokens[i] !== "--await") return false;
    if (i + 1 >= tokens.length || tokens[i + 1].startsWith("--")) return false;
    i += 2;
  }

  return true;
}

function appendParentBashOptionContinuation(logical: ToolCallLogicalLine[], text: string): boolean {
  const previous = logical[logical.length - 1];
  const trimmed = text.trimStart();

  if (!previous?.display.cmd || !isParentBashOptionContinuation(trimmed)) return false;

  previous.text = previous.text ? `${previous.text} ${trimmed}` : trimmed;
  return true;
}

function parseLineHeredocSpecs(line: string): PendingHeredoc[] {
  return scanHeredocOperators(line).operators.map(operator => ({
    terminator: operator.delimiter,
    allowTabs: operator.stripTabs,
  }));
}

function isHeredocTerminatorLine(line: string, spec: PendingHeredoc): boolean {
  return isHeredocDelimiterLine(line, { delimiter: spec.terminator, stripTabs: spec.allowTabs });
}

function advanceShellQuoteState(line: string, initial: ShellQuoteState = null): ShellQuoteState {
  let quote = initial;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }

    if (quote === '"') {
      if (ch === "\\" && i + 1 < line.length) {
        i++;
        continue;
      }
      if (ch === '"') quote = null;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (ch === "\\" && i + 1 < line.length) {
      i++;
      continue;
    }
  }

  return quote;
}

function endsWithShellLineContinuation(line: string, initial: ShellQuoteState = null): boolean {
  let quote = initial;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }

    if (quote === '"') {
      if (ch === "\\") {
        if (i + 1 >= line.length) return true;
        i++;
        continue;
      }
      if (ch === '"') quote = null;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (ch === "\\") {
      if (i + 1 >= line.length) return true;
      i++;
      continue;
    }
  }

  return false;
}

function createShellCommandContinuationState(): ShellCommandContinuationState {
  return { quote: null, pendingHeredocs: [], lineContinuation: false };
}

function hasShellCommandContinuation(state: ShellCommandContinuationState): boolean {
  return state.lineContinuation || state.quote !== null || state.pendingHeredocs.length > 0;
}

function advanceShellCommandContinuationState(
  line: string,
  state: ShellCommandContinuationState = createShellCommandContinuationState(),
): ShellCommandContinuationState {
  const pendingHeredocs = [...state.pendingHeredocs];

  if (pendingHeredocs.length > 0) {
    if (isHeredocTerminatorLine(line, pendingHeredocs[0])) pendingHeredocs.shift();
    return {
      quote: state.quote,
      pendingHeredocs,
      lineContinuation: false,
    };
  }

  const quote = advanceShellQuoteState(line, state.quote);
  const lineContinuation = endsWithShellLineContinuation(line, state.quote);
  if (state.quote === null) pendingHeredocs.push(...parseLineHeredocSpecs(line.trimStart()));

  return { quote, pendingHeredocs, lineContinuation };
}

function maybeContinueExternalCommand(
  display: ResolvedToolDisplay,
  text: string,
  state: ShellCommandContinuationState = createShellCommandContinuationState(),
): PendingExternalCommand | null {
  const nextState = advanceShellCommandContinuationState(text, state);
  return hasShellCommandContinuation(nextState)
    ? { display, state: nextState }
    : null;
}

function shouldPreferLinewiseExternalRender(
  match: BashExternalMatch,
  stdinRange: BashStdinLineRange | null,
): boolean {
  const firstMatchedLine = match.lines[match.matchLineIndex]?.slice(match.matchStart) ?? "";
  let continuation = maybeContinueExternalCommand(match.display, firstMatchedLine);

  for (let i = match.matchLineIndex + 1; i < match.lines.length; i++) {
    // Literal stdin is flattened into the bash summary after `--stdin`. Its
    // newlines do not terminate the matched external command.
    if (isBashStdinContinuationLine(stdinRange, i)) continue;
    if (!continuation) return true;
    continuation = maybeContinueExternalCommand(continuation.display, match.lines[i], continuation.state);
  }

  return false;
}

function appendRenderedBashSegment(
  logical: ToolCallLogicalLine[],
  bashDisplay: ResolvedToolDisplay,
  text: string,
  separator: string,
  match: BashExternalMatch | null,
  continuation?: PendingExternalCommand,
): PendingExternalCommand | null {
  const startIndex = logical.length;

  if (continuation) pushLogicalLine(logical, continuation.display, text, false);
  else appendMatchedBashSegment(logical, bashDisplay, text, match);

  if (separator && logical.length > startIndex) {
    logical[logical.length - 1].text += ` ${separator}`;
    return null;
  }

  if (continuation) return maybeContinueExternalCommand(continuation.display, text, continuation.state);
  if (match) return maybeContinueExternalCommand(match.display, text.slice(match.matchStart));
  return null;
}

function renderSegmentedBashLines(
  summary: string,
  toolRegistry: ToolDisplayInfo[],
  externalToolStyles: ExternalToolStyle[],
  options: SegmentedBashRenderOptions,
  stdinRange: BashStdinLineRange | null,
): ToolCallLogicalLine[] | null {
  if (options.requirePrompts && !isPromptedBashTranscript(summary)) return null;

  const rawLines = summary.trimStart().split("\n");
  const parsedLines: Array<{
    rawLine: string;
    lineText: string;
    lineMatch: BashExternalMatch | null;
    segments: ReturnType<typeof splitTopLevelShellSegments>;
    matches: Array<BashExternalMatch | null>;
    nonEmptySegments: Array<ReturnType<typeof splitTopLevelShellSegments>[number]>;
    hasSegmentMatch: boolean;
    inHeredocBody: boolean;
  }> = [];
  const pendingHeredocs: PendingHeredoc[] = [];
  let pendingQuote: ShellQuoteState = null;

  for (const rawLine of rawLines) {
    const commandLine = stripPromptPrefixIfPresent(rawLine, options.stripPromptPrefix);
    const lineText = commandLine;
    const inHeredocBody = pendingHeredocs.length > 0;

    let lineMatch: BashExternalMatch | null = null;
    let segments: ReturnType<typeof splitTopLevelShellSegments> = [];
    let matches: Array<BashExternalMatch | null> = [];
    let nonEmptySegments: Array<ReturnType<typeof splitTopLevelShellSegments>[number]> = [];
    let hasSegmentMatch = false;

    if (inHeredocBody) {
      while (pendingHeredocs.length > 0 && isHeredocTerminatorLine(commandLine, pendingHeredocs[0])) {
        pendingHeredocs.shift();
      }
    } else {
      lineMatch = resolveBashExternalMatch(lineText, externalToolStyles);
      const split = splitTopLevelShellSegmentsWithState(commandLine, pendingQuote);
      segments = split.segments;
      pendingQuote = split.endingQuote;
      matches = segments.map((segment) => {
        const text = segment.text.trim();
        return text ? resolveBashExternalMatch(text, externalToolStyles) : null;
      });
      nonEmptySegments = segments.filter(segment => segment.text.trim());
      hasSegmentMatch = matches.some(Boolean);
      pendingHeredocs.push(...parseLineHeredocSpecs(commandLine.trimStart()));
    }

    parsedLines.push({ rawLine, lineText, lineMatch, segments, matches, nonEmptySegments, hasSegmentMatch, inHeredocBody });
  }

  if (!options.requirePrompts) {
    const hasMixedLine = parsedLines.some(({ nonEmptySegments, hasSegmentMatch }) =>
      nonEmptySegments.length > 1 && hasSegmentMatch);
    const hasSimpleExternalLine = parsedLines.some(({ lineMatch }) => !!lineMatch);
    if (!hasMixedLine && !(options.allowSimpleExternalLines && hasSimpleExternalLine)) return null;
  }

  const logical: ToolCallLogicalLine[] = [];
  const bashDisplay = resolveToolDisplay("bash", "", toolRegistry, []);
  let pendingExternal: PendingExternalCommand | null = null;

  for (const [lineIndex, { rawLine, lineText, lineMatch, segments, matches, nonEmptySegments, hasSegmentMatch, inHeredocBody }] of parsedLines.entries()) {
    if (pendingExternal && stdinRange && isBashStdinContinuationLine(stdinRange, lineIndex)) {
      pushLogicalLine(logical, pendingExternal.display, lineText, false);
      if (lineIndex >= stdinRange.endLineIndex) pendingExternal = null;
      continue;
    }

    if (pendingExternal?.state.pendingHeredocs.length) {
      pushLogicalLine(logical, pendingExternal.display, lineText, false);
      pendingExternal = maybeContinueExternalCommand(pendingExternal.display, lineText, pendingExternal.state);
      continue;
    }

    if (pendingExternal) {
      const split = splitTopLevelShellSegmentsWithState(lineText, pendingExternal.state.quote);
      let renderedFirstSegment = false;
      let nextPending: PendingExternalCommand | null = null;

      for (const segment of split.segments) {
        const isContinuationSegment = !renderedFirstSegment;
        const text = isContinuationSegment ? segment.text : segment.text.trim();
        if (!isContinuationSegment && !text) continue;

        const match = isContinuationSegment || !text
          ? null
          : resolveBashExternalMatch(text, externalToolStyles);
        nextPending = appendRenderedBashSegment(
          logical,
          bashDisplay,
          text,
          segment.separator,
          match,
          isContinuationSegment ? pendingExternal : undefined,
        );
        renderedFirstSegment = true;
      }

      pendingExternal = nextPending;
      continue;
    }

    if (!rawLine.trim()) {
      pushLogicalLine(logical, bashDisplay, "", false);
      continue;
    }

    if (!inHeredocBody && appendParentBashOptionContinuation(logical, lineText)) continue;

    if (inHeredocBody || lineMatch || nonEmptySegments.length <= 1 || !hasSegmentMatch) {
      pendingExternal = appendRenderedBashSegment(logical, bashDisplay, lineText, "", inHeredocBody ? null : lineMatch);
      if (
        lineMatch
        && stdinRange
        && lineIndex === stdinRange.startLineIndex
        && stdinRange.endLineIndex > lineIndex
      ) {
        // The first stdin line is appended to the real command line. Keep its
        // external-tool display active for the remaining literal data lines;
        // do not derive shell quote/heredoc state from that unquoted data.
        pendingExternal = { display: lineMatch.display, state: createShellCommandContinuationState() };
      }
      continue;
    }

    pendingExternal = null;
    for (const [segmentIndex, segment] of segments.entries()) {
      const text = segment.text.trim();
      if (!text) continue;
      pendingExternal = appendRenderedBashSegment(logical, bashDisplay, text, segment.separator, matches[segmentIndex]);
    }
  }

  return logical;
}

// ── Payloads: heredoc bodies and literal stdin ─────────────────────

type PayloadTarget =
  | { kind: "tool"; display: ResolvedToolDisplay; noun: string }
  | { kind: "script"; language: string }
  | { kind: "text"; language?: string };

/** Interpreters that run a heredoc fed to them as a script, by highlight language. */
const INTERPRETER_LANGUAGES: Record<string, string> = {
  python: "python", python3: "python", python2: "python", pypy: "python", pypy3: "python",
  node: "javascript", bun: "typescript", deno: "typescript", tsx: "typescript", "ts-node": "typescript",
  bash: "bash", sh: "bash", zsh: "bash", dash: "bash", ksh: "bash", fish: "fish",
  ruby: "ruby", perl: "perl", php: "php", lua: "lua", Rscript: "r",
  psql: "sql", sqlite3: "sql", mysql: "sql", duckdb: "sql",
};
/** Interpreters whose operands are databases or connections, not script files. */
const SQL_CLIENTS = new Set(["psql", "sqlite3", "mysql", "duckdb"]);
/** Subcommands whose input is a message someone reads. */
const MESSAGE_SUBCOMMANDS = new Set(["send", "reply", "post", "message", "dm", "compose", "draft", "comment", "tweet"]);
/** Tools whose recipients see markdown rendered. */
const MARKDOWN_PAYLOAD_TOOLS = new Set(["discord"]);

function commandName(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

/** The highlight language for a file path's extension, if supported. */
function languageForPath(path: string): string | undefined {
  const dot = path.lastIndexOf(".");
  if (dot < 0 || dot < path.lastIndexOf("/")) return undefined;
  const ext = path.slice(dot + 1).toLowerCase();
  return ext && isLanguageSupported(ext) ? ext : undefined;
}

/** Words that belong to the command proper: stops at the first control operator. */
function commandOperands(words: string[]): string[] {
  const out: string[] = [];
  for (const word of words) {
    if (/^(?:\||;|&&|\)|`)/.test(word)) break;
    out.push(word);
  }
  return out;
}

/** Target of an output redirection (`> file`, `>>file`, `1>file`), if any. */
function redirectionTarget(words: string[]): string | null {
  for (let i = 0; i < words.length; i++) {
    const match = /^\d*>>?(.*)$/.exec(words[i]);
    if (!match) continue;
    if (match[1] && !match[1].startsWith("&")) return match[1];
    if (!match[1] && i + 1 < words.length) return words[i + 1];
  }
  return null;
}

/**
 * Who reads a payload fed to `text`'s command. `cat` with no file operands only
 * passes it on, so the caller follows the pipe (or the enclosing command).
 */
function classifyPayloadReceiver(
  text: string,
  externalToolStyles: ExternalToolStyle[],
): PayloadTarget | "passthrough" {
  const words = commandOperands(shellCommandWords(text) ?? []);
  if (words.length === 0) return { kind: "text" };
  const name = commandName(words[0]);
  const operands = words.slice(1).filter(word => !word.startsWith("<<") && !/^\d*[<>]/.test(word));

  if (name === "cat") {
    const target = redirectionTarget(words);
    if (target) return { kind: "text", language: languageForPath(target) };
    return operands.every(word => word === "-" || word.startsWith("-")) ? "passthrough" : { kind: "text" };
  }
  if (name === "tee") {
    const file = operands.find(word => !word.startsWith("-"));
    return { kind: "text", language: file ? languageForPath(file) : undefined };
  }

  const language = INTERPRETER_LANGUAGES[name] ?? (/^python3\.\d+$/.test(name) ? "python" : undefined);
  if (language) {
    const args = operands.filter(word => !word.startsWith("-") || word === "-");
    const script = name === "bun" && args[0] === "run" ? args[1] : args[0];
    if (SQL_CLIENTS.has(name) || script === undefined || script === "-") {
      return isLanguageSupported(language) ? { kind: "script", language } : { kind: "text" };
    }
    return { kind: "text" };
  }

  const external = resolveBashExternalMatch(text.trim(), externalToolStyles);
  if (external) {
    const noun = words.slice(1).some(word => MESSAGE_SUBCOMMANDS.has(word)) ? "message" : "input";
    return { kind: "tool", display: external.display, noun };
  }
  return { kind: "text" };
}

/** The top-level command after the one containing `offset`, when a pipe connects them. */
function pipedCommandAfter(line: string, offset: number, nextLine: string | undefined): string | null {
  const segments = splitTopLevelShellSegments(line);
  const index = segments.findIndex((segment, i) => offset >= segment.start
    && (i === segments.length - 1 || offset < segments[i + 1].start));
  const segment = segments[index];
  if (!segment || (segment.separator !== "|" && segment.separator !== "|&")) return null;
  const next = segments[index + 1]?.text.trim();
  return next || nextLine?.trim() || null;
}

function heredocTarget(
  piece: HeredocPiece,
  nextShellLine: string | undefined,
  externalToolStyles: ExternalToolStyle[],
): PayloadTarget {
  const { openerLine, operator } = piece;
  const own = splitTopLevelShellSegments(openerLine.slice(operator.commandStart))[0]?.text ?? "";
  const receiver = classifyPayloadReceiver(own, externalToolStyles);
  if (receiver !== "passthrough") return receiver;

  // `cat <<EOF` only forwards the body: to the command whose argument the
  // substitution is, or down the pipe.
  const forwardedTo = operator.inSubstitution
    ? openerLine.slice(operator.outerCommandStart)
    : pipedCommandAfter(openerLine, operator.start, nextShellLine);
  if (!forwardedTo) return { kind: "text" };
  const forwarded = classifyPayloadReceiver(forwardedTo, externalToolStyles);
  return forwarded === "passthrough" ? { kind: "text" } : forwarded;
}

/** Who reads the call's literal stdin: the external tool the command runs, else its first command. */
function stdinTarget(command: string, externalToolStyles: ExternalToolStyle[]): PayloadTarget {
  const external = resolveBashExternalMatch(command, externalToolStyles);
  if (external) {
    const receiver = classifyPayloadReceiver(external.lines[external.matchLineIndex].slice(external.matchStart), externalToolStyles);
    if (receiver !== "passthrough" && receiver.kind === "tool") return receiver;
  }
  const firstLine = command.trimStart().split("\n")[0] ?? "";
  const first = splitTopLevelShellSegments(firstLine)[0];
  if (!first) return { kind: "text" };
  const receiver = classifyPayloadReceiver(first.text, externalToolStyles);
  if (receiver !== "passthrough") return receiver;
  const next = pipedCommandAfter(firstLine, first.start, undefined);
  const forwarded = next ? classifyPayloadReceiver(next, externalToolStyles) : "passthrough";
  return forwarded === "passthrough" ? { kind: "text" } : forwarded;
}

function pushPayload(
  logical: ToolCallLogicalLine[],
  bashDisplay: ResolvedToolDisplay,
  target: PayloadTarget,
  body: string[],
  terminator: string | null,
): void {
  const display = target.kind === "tool" ? target.display : bashDisplay;
  const block: ToolCallPayload = target.kind === "tool"
    ? { kind: "tool", ...(MARKDOWN_PAYLOAD_TOOLS.has(commandName(target.display.cmd ?? "")) ? { markdown: true } : {}) }
    : { kind: target.kind, ...(target.language ? { language: target.language } : {}) };

  if (target.kind === "tool") {
    logical.push({ display, text: `${display.label} ${target.noun}`, hasLabel: true, payload: { block, role: "title" } });
  }
  for (const line of body) logical.push({ display, text: line, hasLabel: false, payload: { block, role: "body" } });
  if (terminator !== null) logical.push({ display, text: terminator, hasLabel: false, payload: { block, role: "end" } });
}

// ── Command/parameter split ────────────────────────────────────────

interface ShellCall {
  /** The command text alone. */
  command: string;
  /** Other call parameters as the summary lists them (`--timeout_seconds 120`). */
  meta: string;
  /** Literal stdin passed as a call parameter. */
  stdin: string | null;
}

/**
 * Split a shell call's summary into its command and the parameters the daemon
 * appended after it. Calls without their input (older history) keep the
 * whole summary as the command.
 */
function splitShellCall(summary: string, toolInput: Record<string, unknown> | undefined): ShellCall | null {
  if (typeof toolInput?.command !== "string") return null;
  const command = sanitizeUntrustedText(toolInput.command);
  if (!command.trim() || !summary.startsWith(command)) return null;

  let rest = summary.slice(command.length);
  let stdin: string | null = null;
  if (typeof toolInput.stdin === "string") {
    const value = sanitizeUntrustedText(toolInput.stdin);
    const marker = ` --stdin ${value}`;
    const at = rest.indexOf(marker);
    if (at >= 0 && value) {
      rest = rest.slice(0, at) + rest.slice(at + marker.length);
      stdin = value;
    }
  }
  return { command, meta: rest.trim(), stdin };
}

/**
 * Older history has no separable parameters: `--timeout 120000` was glued to
 * the last line, which hides a heredoc's closing delimiter (`EOF --timeout
 * 120000`). Recover the delimiter and the parameters.
 */
function recoverGluedHeredocMeta(pieces: CommandPiece[]): string {
  const last = pieces[pieces.length - 1];
  if (last?.type !== "heredoc" || last.terminator !== null || last.body.length === 0) return "";
  const line = last.body[last.body.length - 1];
  if (!line.startsWith(`${last.operator.delimiter} --`)) return "";
  const meta = line.slice(last.operator.delimiter.length).trim();
  if (!/^--[A-Za-z_][\w-]*(?: [^\s-]\S*)?(?: --[A-Za-z_][\w-]*(?: [^\s-]\S*)?)*$/.test(meta)) return "";
  last.body.pop();
  last.terminator = last.operator.delimiter;
  return meta;
}

// ── Bash rendering ─────────────────────────────────────────────────

/** Render shell text that contains no heredoc bodies. */
function renderBashText(
  summary: string,
  toolRegistry: ToolDisplayInfo[],
  externalToolStyles: ExternalToolStyle[],
  stdinRange: BashStdinLineRange | null,
): ToolCallLogicalLine[] {
  const logical = renderSegmentedBashLines(summary, toolRegistry, externalToolStyles, {
    requirePrompts: true,
    stripPromptPrefix: true,
  }, stdinRange)
    ?? renderSegmentedBashLines(summary, toolRegistry, externalToolStyles, {
      requirePrompts: false,
      stripPromptPrefix: true,
    }, stdinRange)
    ?? [];

  if (logical.length !== 0) return logical;

  const bashExternal = resolveBashExternalMatch(summary, externalToolStyles);

  if (bashExternal) {
    const segmented = shouldPreferLinewiseExternalRender(bashExternal, stdinRange)
      ? renderSegmentedBashLines(summary, toolRegistry, externalToolStyles, {
          requirePrompts: false,
          stripPromptPrefix: true,
          allowSimpleExternalLines: true,
        }, stdinRange)
      : null;

    if (segmented) return segmented;

    const bashDisplay = resolveToolDisplay("bash", "", toolRegistry, []);

    for (const [lineIndex, rawLine] of bashExternal.lines.entries()) {
      if (lineIndex < bashExternal.matchLineIndex) {
        const trimmed = rawLine.trimStart();
        if (!trimmed) pushLogicalLine(logical, bashDisplay, "", false);
        else pushLogicalLine(logical, bashDisplay, rawLine, true);
        continue;
      }

      if (lineIndex === bashExternal.matchLineIndex) {
        const prefix = rawLine.slice(0, bashExternal.matchStart).trimEnd();
        if (prefix.trim()) pushLogicalLine(logical, bashDisplay, prefix, true);
        pushCommandDetail(logical, bashExternal.display);
      }
      break;
    }

    return logical;
  }

  const segmented = renderSegmentedBashLines(summary, toolRegistry, externalToolStyles, {
    requirePrompts: false,
    stripPromptPrefix: true,
    allowSimpleExternalLines: true,
  }, stdinRange);

  if (segmented) return segmented;

  pushCommandDetail(logical, resolveToolDisplay("bash", summary, toolRegistry, externalToolStyles));
  return logical;
}

/** Render a command with heredocs: shell pieces as commands, bodies as payload blocks. */
function renderHeredocPieces(
  pieces: CommandPiece[],
  toolRegistry: ToolDisplayInfo[],
  externalToolStyles: ExternalToolStyle[],
): ToolCallLogicalLine[] {
  const logical: ToolCallLogicalLine[] = [];
  const bashDisplay = resolveToolDisplay("bash", "", toolRegistry, []);
  let lastCommandDisplay = bashDisplay;

  for (const [index, piece] of pieces.entries()) {
    if (piece.type === "heredoc") {
      const next = pieces.slice(index + 1).find(candidate => candidate.type === "shell");
      const nextShellLine = next?.type === "shell" ? next.lines.find(line => line.trim()) : undefined;
      pushPayload(logical, bashDisplay, heredocTarget(piece, nextShellLine, externalToolStyles), piece.body, piece.terminator);
      continue;
    }

    let lines = piece.lines;
    // `)"` after `"$(cat <<'EOF'` finishes the command that opened the heredoc.
    for (const line of lines.slice(0, piece.continuationLines)) {
      pushLogicalLine(logical, lastCommandDisplay, line, false);
    }
    lines = lines.slice(piece.continuationLines);
    if (index === pieces.length - 1) {
      while (lines.length > 0 && !lines[lines.length - 1].trim()) lines = lines.slice(0, -1);
    }
    while (lines.length > 0 && !lines[0].trim()) {
      pushLogicalLine(logical, bashDisplay, "", false);
      lines = lines.slice(1);
    }
    if (lines.length === 0) continue;

    const rendered = renderBashText(lines.join("\n"), toolRegistry, externalToolStyles, null);
    logical.push(...rendered);
    const lastCommand = rendered.filter(line => !line.payload).at(-1);
    if (lastCommand) lastCommandDisplay = lastCommand.display;
  }

  return logical;
}

export function renderToolCallLogicalLines(
  toolName: string,
  summary: string,
  toolRegistry: ToolDisplayInfo[],
  externalToolStyles: ExternalToolStyle[],
  toolInput?: Record<string, unknown>,
): ToolCallLogicalLine[] {
  if (toolName === "exec_command") {
    return renderToolCallLogicalLines("bash", summary, toolRegistry, externalToolStyles,
      toolInput ? { ...toolInput, command: toolInput.cmd } : undefined);
  }
  // Claude Code's Bash (anthropic provider) takes the same command input.
  if (toolName === "Bash") {
    return renderToolCallLogicalLines("bash", summary, toolRegistry, externalToolStyles, toolInput);
  }
  if (toolName !== "bash") {
    const logical: ToolCallLogicalLine[] = [];
    pushCommandDetail(logical, resolveToolDisplay(toolName, summary, toolRegistry, externalToolStyles));
    return logical;
  }

  const call = splitShellCall(summary, toolInput);
  const command = call?.command ?? summary;
  const pieces = splitHeredocPieces(command);
  let meta = call?.meta ?? "";
  if (!call) meta = recoverGluedHeredocMeta(pieces);

  const logical = hasHeredocPiece(pieces)
    ? renderHeredocPieces(pieces, toolRegistry, externalToolStyles)
    : renderBashText(command, toolRegistry, externalToolStyles, call ? null : bashStdinLineRange(summary, toolInput));

  if (call?.stdin) {
    const bashDisplay = resolveToolDisplay("bash", "", toolRegistry, []);
    pushPayload(logical, bashDisplay, stdinTarget(command, externalToolStyles), call.stdin.replace(/\n$/, "").split("\n"), null);
  }
  const first = logical.find(line => !line.payload);
  if (meta && first) first.meta = meta;
  return logical;
}
