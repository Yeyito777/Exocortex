/**
 * Heredoc parsing for tool-call rendering.
 *
 * A shell command shown in the chat may carry heredoc bodies (`<<EOF` …
 * `EOF`). Body lines are data, not commands, so the renderer splits the command
 * into shell pieces and heredoc bodies first. This is not a shell parser: it
 * tracks quotes, `$(…)` substitutions, backticks and comments well enough to
 * find real `<<` operators and their delimiters.
 */

export interface HeredocOperator {
  /** Offset of `<<` in the line. */
  start: number;
  /** Delimiter word with quotes removed. */
  delimiter: string;
  /** `<<-`: leading tabs are stripped from body and delimiter lines. */
  stripTabs: boolean;
  /** Offset where the simple command that owns the operator starts. */
  commandStart: number;
  /** Offset where the top-level command containing the operator starts. */
  outerCommandStart: number;
  /** The operator sits inside `$(…)` or backticks: its command's output is an argument. */
  inSubstitution: boolean;
}

type ScanFrame =
  | { kind: "'" }
  | { kind: '"' }
  | { kind: "$(" | "`" | "top"; commandStart: number; parens: number }
  | { kind: "$((" };

/** Quote/substitution state carried from one physical line to the next. */
export interface HeredocScanState {
  frames: ScanFrame[];
}

export function createHeredocScanState(): HeredocScanState {
  return { frames: [] };
}

/** Whether a line ending in this state leaves a quote or substitution open. */
export function isHeredocScanStateOpen(state: HeredocScanState): boolean {
  return state.frames.length > 0;
}

const COMMAND_BOUNDARY = new Set([";", "|", "&", "(", ")", "{", "}", "\n"]);
const WORD_END = /[\s;|&<>()]/;

function readDelimiterWord(line: string, from: number): { word: string; end: number } {
  let i = from;
  let word = "";
  while (i < line.length && !WORD_END.test(line[i])) {
    const ch = line[i];
    if (ch === "'" || ch === '"') {
      const close = line.indexOf(ch, i + 1);
      const end = close < 0 ? line.length : close;
      word += line.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (ch === "\\" && i + 1 < line.length) {
      word += line[i + 1];
      i += 2;
      continue;
    }
    word += ch;
    i++;
  }
  return { word, end: i };
}

/**
 * Find the heredoc operators on one physical line, continuing from the state
 * the previous line ended in. Here-strings (`<<<`), shifts inside `$((…))`,
 * quoted text and comments are not operators.
 */
export function scanHeredocOperators(
  line: string,
  initial: HeredocScanState = createHeredocScanState(),
): { operators: HeredocOperator[]; state: HeredocScanState } {
  const frames: ScanFrame[] = initial.frames.map(frame => ({ ...frame }));
  const top: ScanFrame = { kind: "top", commandStart: 0, parens: 0 };
  const current = (): ScanFrame => frames[frames.length - 1] ?? top;
  const commandFrame = () => {
    for (let f = frames.length - 1; f >= 0; f--) {
      const frame = frames[f];
      if (frame.kind === "$(" || frame.kind === "`") return frame;
    }
    return top;
  };
  const operators: HeredocOperator[] = [];
  let atWordStart = true;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const frame = current();

    if (frame.kind === "'") {
      if (ch === "'") frames.pop();
      atWordStart = false;
      continue;
    }

    if (frame.kind === '"') {
      if (ch === "\\") i++;
      else if (ch === '"') frames.pop();
      else if (ch === "$" && line[i + 1] === "(" && line[i + 2] !== "(") {
        frames.push({ kind: "$(", commandStart: i + 2, parens: 0 });
        i++;
      } else if (ch === "`") frames.push({ kind: "`", commandStart: i + 1, parens: 0 });
      atWordStart = false;
      continue;
    }

    if (frame.kind === "$((") {
      if (ch === ")" && line[i + 1] === ")") {
        frames.pop();
        i++;
      }
      continue;
    }

    // Unquoted context: the top level, `$(…)` or backticks.
    if (ch === "\\") {
      i++;
      atWordStart = false;
      continue;
    }
    if (ch === "#" && atWordStart) break;
    if (ch === "'" || ch === '"') {
      frames.push({ kind: ch });
      atWordStart = false;
      continue;
    }
    if (ch === "`") {
      if (frame.kind === "`") frames.pop();
      else frames.push({ kind: "`", commandStart: i + 1, parens: 0 });
      atWordStart = true;
      continue;
    }
    if (ch === "$" && line[i + 1] === "(") {
      if (line[i + 2] === "(") {
        frames.push({ kind: "$((" });
        i += 2;
      } else {
        frames.push({ kind: "$(", commandStart: i + 2, parens: 0 });
        i++;
      }
      atWordStart = true;
      continue;
    }
    if (ch === ")" && frame.kind === "$(" && frame.parens === 0) {
      frames.pop();
      atWordStart = false;
      continue;
    }
    if (ch === "(") frame.parens++;
    else if (ch === ")") frame.parens = Math.max(0, frame.parens - 1);
    if (ch === "<" && line[i + 1] === "<" && line[i - 1] !== "<" && line[i + 2] !== "<") {
      const stripTabs = line[i + 2] === "-";
      let j = i + (stripTabs ? 3 : 2);
      while (line[j] === " " || line[j] === "\t") j++;
      const { word, end } = readDelimiterWord(line, j);
      if (word) {
        const owner = commandFrame();
        operators.push({
          start: i,
          delimiter: word,
          stripTabs,
          commandStart: owner.commandStart,
          outerCommandStart: top.commandStart,
          inSubstitution: owner !== top,
        });
        i = end - 1;
        atWordStart = false;
        continue;
      }
    }
    // `2>&1`, `<&3` and `&>file` are redirections, not command boundaries.
    const isRedirection = ch === "&" && (line[i - 1] === ">" || line[i - 1] === "<" || line[i + 1] === ">");
    if (COMMAND_BOUNDARY.has(ch) && !isRedirection) commandFrame().commandStart = i + 1;
    atWordStart = /[\s;|&(){}]/.test(ch);
  }

  return { operators, state: { frames } };
}

/** Whether `line` closes a heredoc. Tabs were already sanitized to four spaces. */
export function isHeredocDelimiterLine(line: string, operator: Pick<HeredocOperator, "delimiter" | "stripTabs">): boolean {
  if (line === operator.delimiter) return true;
  return operator.stripTabs && line.replace(/^(?:\t|    )+/, "") === operator.delimiter;
}

export interface ShellPiece {
  type: "shell";
  lines: string[];
  /**
   * The line before this piece opened a heredoc while a quote or `$(` was
   * still open, so this piece's first `continuationLines` lines finish that
   * command (`)"` after `"$(cat <<'EOF'`) rather than start new ones.
   */
  continuationLines: number;
}

export interface HeredocPiece {
  type: "heredoc";
  operator: HeredocOperator;
  /** The physical line that opened the heredoc. */
  openerLine: string;
  body: string[];
  /** The closing delimiter line, or null when the command ends first. */
  terminator: string | null;
}

export type CommandPiece = ShellPiece | HeredocPiece;

/**
 * Split a command into shell pieces and heredoc bodies, in source order.
 * Without heredocs the result is a single shell piece.
 */
export function splitHeredocPieces(command: string): CommandPiece[] {
  const lines = command.split("\n");
  const pieces: CommandPiece[] = [];
  let shell: ShellPiece | null = null;
  let state = createHeredocScanState();
  let pending: Array<{ operator: HeredocOperator; openerLine: string }> = [];
  let heredoc: HeredocPiece | null = null;
  let openAfterHeredoc = false;

  for (const line of lines) {
    if (pending.length > 0) {
      if (!heredoc) {
        const next = pending[0];
        heredoc = { type: "heredoc", operator: next.operator, openerLine: next.openerLine, body: [], terminator: null };
        pieces.push(heredoc);
      }
      if (isHeredocDelimiterLine(line, heredoc.operator)) {
        heredoc.terminator = line;
        heredoc = null;
        pending.shift();
      } else {
        heredoc.body.push(line);
      }
      continue;
    }

    if (!shell) {
      shell = { type: "shell", lines: [], continuationLines: 0 };
      pieces.push(shell);
    }
    shell.lines.push(line);
    const wasOpen = isHeredocScanStateOpen(state);
    const scanned = scanHeredocOperators(line, state);
    state = scanned.state;
    if (openAfterHeredoc && wasOpen) shell.continuationLines++;
    if (scanned.operators.length > 0) {
      pending = scanned.operators.map(operator => ({ operator, openerLine: line }));
      openAfterHeredoc = isHeredocScanStateOpen(state);
      shell = null;
    } else if (!isHeredocScanStateOpen(state)) {
      openAfterHeredoc = false;
    }
  }

  return pieces;
}

/** Whether the command contains at least one heredoc. */
export function hasHeredocPiece(pieces: CommandPiece[]): boolean {
  return pieces.some(piece => piece.type === "heredoc");
}
