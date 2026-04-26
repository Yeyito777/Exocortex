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
  type BashExternalMatch,
  type ResolvedToolDisplay,
} from "./toolstyles";
import {
  splitTopLevelShellSegments,
  splitTopLevelShellSegmentsWithState,
  type ShellQuoteState,
} from "./bashsegments";

export interface ToolCallLogicalLine {
  display: ResolvedToolDisplay;
  text: string;
  hasLabel: boolean;
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

  for (let i = 0; i < tokens.length; i += 2) {
    if (tokens[i] !== "--timeout" && tokens[i] !== "--await") return false;
    if (i + 1 >= tokens.length || tokens[i + 1].startsWith("--")) return false;
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
  const specs: PendingHeredoc[] = [];
  const regex = /<<(-)?\s*(?:'([^']*)'|"([^"]*)"|\\?([^\s'"`]+))/g;

  for (const match of line.matchAll(regex)) {
    const terminator = match[2] ?? match[3] ?? match[4];
    if (!terminator) continue;
    specs.push({
      terminator: terminator.startsWith("\\") ? terminator.slice(1) : terminator,
      allowTabs: match[1] === "-",
    });
  }

  return specs;
}

function isHeredocTerminatorLine(line: string, spec: PendingHeredoc): boolean {
  return spec.allowTabs ? line.replace(/^\t+/, "") === spec.terminator : line === spec.terminator;
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

function shouldPreferLinewiseExternalRender(match: BashExternalMatch): boolean {
  const firstMatchedLine = match.lines[match.matchLineIndex]?.slice(match.matchStart) ?? "";
  let continuation = maybeContinueExternalCommand(match.display, firstMatchedLine);

  for (let i = match.matchLineIndex + 1; i < match.lines.length; i++) {
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

  for (const { rawLine, lineText, lineMatch, segments, matches, nonEmptySegments, hasSegmentMatch, inHeredocBody } of parsedLines) {
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

export function renderToolCallLogicalLines(
  toolName: string,
  summary: string,
  toolRegistry: ToolDisplayInfo[],
  externalToolStyles: ExternalToolStyle[],
): ToolCallLogicalLine[] {
  const display = resolveToolDisplay(toolName, summary, toolRegistry, externalToolStyles);

  // Build logical display lines. Each entry carries its own display, so bash
  // blocks can mix plain bash prelude lines with styled external-tool lines
  // without dropping the setup commands.
  const logical = toolName === "bash"
    ? renderSegmentedBashLines(summary, toolRegistry, externalToolStyles, {
        requirePrompts: true,
        stripPromptPrefix: true,
      })
      ?? renderSegmentedBashLines(summary, toolRegistry, externalToolStyles, {
        requirePrompts: false,
        stripPromptPrefix: true,
      })
      ?? []
    : [];

  if (logical.length !== 0) return logical;

  const bashExternal = toolName === "bash"
    ? resolveBashExternalMatch(summary, externalToolStyles)
    : null;

  if (bashExternal) {
    const segmented = shouldPreferLinewiseExternalRender(bashExternal)
      ? renderSegmentedBashLines(summary, toolRegistry, externalToolStyles, {
          requirePrompts: false,
          stripPromptPrefix: true,
          allowSimpleExternalLines: true,
        })
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

  const segmented = toolName === "bash"
    ? renderSegmentedBashLines(summary, toolRegistry, externalToolStyles, {
        requirePrompts: false,
        stripPromptPrefix: true,
        allowSimpleExternalLines: true,
      })
    : null;

  if (segmented) return segmented;

  pushCommandDetail(logical, display);
  return logical;
}
