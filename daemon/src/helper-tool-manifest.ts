import { constants } from "fs";
import { open, readdir, stat } from "fs/promises";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import type { ExternalToolStyle, ToolCallPresentation } from "@exocortex/shared/messages";
import { log } from "./log";

const MANIFEST_NAME = "exo-manifest.json";
/** Full external-tool manifest (external-tools/TOOL_STANDARD.md); also used by CLI-shaped helper tools. */
const TOOL_MANIFEST_NAME = "manifest.json";
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_PRESENTATION_STYLES = 4;
const MAX_LABEL_LENGTH = 64;
const MANIFEST_LOOKUP_TIMEOUT_MS = 100;
const MAX_CONCURRENT_MANIFEST_READS = 4;
/** Cached manifests used by the synchronous presenter are re-read in the background after this. */
const MANIFEST_CACHE_TTL_MS = 30_000;
const MAX_MANIFEST_CACHE_ENTRIES = 512;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const DYNAMIC_PATH_CHARACTER = /[$`*?\[\]{}]/;
const UNSUPPORTED_SHELL_CHARACTER = new Set(["<", ">", "(", ")", "`"]);

interface ShellToken {
  text: string;
  start: number;
  end: number;
}

interface ShellSegment {
  text: string;
  separator: string;
}

interface ManifestDisplay {
  label: string;
  color: string;
}

/**
 * A parsed display manifest. Helper manifests style every executable beside
 * them; a full tool manifest styles only the executable its `bin` names.
 */
interface ParsedManifest extends ManifestDisplay {
  binPath?: string;
}

interface ExecutableCandidate {
  /** Raw executable token, as the TUI sees it in the command text. */
  cmd: string;
  /** Absolute path the token runs. */
  executablePath: string;
}

let activeManifestReads = 0;
const manifestCache = new Map<string, { manifest: ParsedManifest | null; readAt: number }>();
const manifestRefreshes = new Set<string>();

function isShellWhitespace(ch: string): boolean {
  return /\s/.test(ch);
}

function startsShellComment(command: string, index: number, segmentStart: number): boolean {
  return command[index] === "#"
    && (index === segmentStart || isShellWhitespace(command[index - 1] ?? ""));
}

interface PendingHeredoc {
  terminator: string;
  stripTabs: boolean;
}

/** Characters that end an unquoted heredoc delimiter word. */
const HEREDOC_WORD_END = /[\s;&|<>()]/;

/** Parse the delimiter after `<<` / `<<-`; returns its spec and where the operator ends. */
function parseHeredocOperator(command: string, start: number): { spec: PendingHeredoc; end: number } | null {
  let i = start + 2;
  const stripTabs = command[i] === "-";
  if (stripTabs) i++;
  while (command[i] === " " || command[i] === "\t") i++;
  let terminator = "";
  while (i < command.length && !HEREDOC_WORD_END.test(command[i]!)) {
    const ch = command[i]!;
    if (ch === "'" || ch === '"') {
      const close = command.indexOf(ch, i + 1);
      if (close < 0) return null;
      terminator += command.slice(i + 1, close);
      i = close + 1;
    } else if (ch === "\\" && i + 1 < command.length) {
      terminator += command[i + 1]!;
      i += 2;
    } else {
      terminator += ch;
      i++;
    }
  }
  return terminator ? { spec: { terminator, stripTabs }, end: i } : null;
}

/**
 * Heredoc bodies are shell data rather than commands: drop them so a
 * command-looking body line is never styled, while the command that reads the
 * heredoc still is. Returns null when a heredoc cannot be paired with its
 * terminator; the caller then styles nothing rather than guess.
 */
function stripHeredocBodies(command: string): string | null {
  let quote: "'" | '"' | null = null;
  let comment = false;
  let output = "";
  const pending: PendingHeredoc[] = [];

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "\n" && pending.length > 0 && !quote) {
      output += ch;
      comment = false;
      // Bodies follow the operator's line, one after another.
      let lineStart = i + 1;
      for (const spec of pending) {
        for (;;) {
          if (lineStart > command.length) return null;
          const newline = command.indexOf("\n", lineStart);
          const lineEnd = newline < 0 ? command.length : newline;
          const line = command.slice(lineStart, lineEnd);
          lineStart = lineEnd + 1;
          if ((spec.stripTabs ? line.replace(/^\t+/, "") : line) === spec.terminator) break;
        }
      }
      pending.length = 0;
      i = lineStart - 1;
      continue;
    }
    output += ch;
    if (comment) {
      if (ch === "\n") comment = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < command.length) output += command[++i]!;
      else if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      output += command[++i]!;
      continue;
    }
    if (startsShellComment(command, i, 0)) {
      comment = true;
      continue;
    }
    if (ch === "<" && command[i + 1] === "<") {
      if (command[i + 2] === "<") {
        output += "<<";
        i += 2;
        continue;
      }
      const operator = parseHeredocOperator(command, i);
      if (!operator) return null;
      pending.push(operator.spec);
      output += command.slice(i + 1, operator.end);
      i = operator.end - 1;
    }
  }

  return pending.length > 0 ? null : output;
}

function splitTopLevelShellSegments(command: string): ShellSegment[] {
  const segments: ShellSegment[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let comment = false;
  // Open `$(` command substitutions: their control operators belong to them.
  let substitutionDepth = 0;

  for (let i = 0; i < command.length;) {
    const ch = command[i]!;
    if (comment) {
      if (ch !== "\n") {
        i++;
        continue;
      }
      comment = false;
    } else if (quote === "'") {
      if (ch === "'") quote = null;
      i++;
      continue;
    } else if (quote === '"') {
      if (ch === "\\" && i + 1 < command.length) {
        i += 2;
        continue;
      }
      if (ch === '"') quote = null;
      i++;
      continue;
    } else if (ch === "$" && command[i + 1] === "(") {
      substitutionDepth++;
      i += 2;
      continue;
    } else if (substitutionDepth > 0 && (ch === "(" || ch === ")")) {
      substitutionDepth += ch === "(" ? 1 : -1;
      i++;
      continue;
    } else if (substitutionDepth > 0 && ch !== "'" && ch !== '"' && ch !== "\\") {
      i++;
      continue;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      i++;
      continue;
    } else if (ch === "\\" && i + 1 < command.length) {
      i += 2;
      continue;
    } else if (startsShellComment(command, i, start)) {
      comment = true;
      i++;
      continue;
    }

    const separator = ch === "\n"
      ? "\n"
      : ch === ";"
        ? ";"
        : ch === "&"
          ? (command[i + 1] === "&" ? "&&" : "&")
          : ch === "|"
            ? (command[i + 1] === "|" ? "||" : command[i + 1] === "&" ? "|&" : "|")
            : "";
    if (!separator) {
      i++;
      continue;
    }

    segments.push({ text: command.slice(start, i), separator });
    i += separator.length;
    start = i;
  }

  segments.push({ text: command.slice(start), separator: "" });
  return segments;
}

function splitAtFirstTopLevelRedirection(segment: string): string {
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < segment.length) i++;
      else if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\\" && i + 1 < segment.length) {
      i++;
      continue;
    }
    if (startsShellComment(segment, i, 0)) return segment.slice(0, i);
    if (ch !== "<" && ch !== ">") continue;

    let start = i;
    if (ch === ">" && i > 0 && segment[i - 1] === "&") {
      start = i - 1;
    } else {
      while (start > 0 && /[0-9]/.test(segment[start - 1]!)) start--;
    }
    return segment.slice(0, start);
  }

  return segment;
}

function tokenizeSimpleShellCommand(command: string): ShellToken[] | null {
  const tokens: ShellToken[] = [];
  let i = 0;

  while (i < command.length) {
    while (i < command.length && isShellWhitespace(command[i]!)) i++;
    if (i >= command.length || command[i] === "#") break;
    if (UNSUPPORTED_SHELL_CHARACTER.has(command[i]!)) return null;

    const start = i;
    let text = "";
    while (i < command.length && !isShellWhitespace(command[i]!)) {
      const ch = command[i]!;
      if (UNSUPPORTED_SHELL_CHARACTER.has(ch)) return null;
      if (ch === "'") {
        i++;
        while (i < command.length && command[i] !== "'") text += command[i++]!;
        if (i >= command.length) return null;
        i++;
        continue;
      }
      if (ch === '"') {
        i++;
        let closed = false;
        while (i < command.length) {
          const inner = command[i]!;
          if (inner === '"') {
            closed = true;
            i++;
            break;
          }
          if (inner === "\\") {
            if (i + 1 >= command.length) return null;
            const next = command[i + 1]!;
            if (next === '"' || next === "$" || next === "`" || next === "\\") {
              text += next;
              i += 2;
              continue;
            }
            if (next === "\n") {
              i += 2;
              continue;
            }
          }
          text += inner;
          i++;
        }
        if (!closed) return null;
        continue;
      }
      if (ch === "\\") {
        if (i + 1 >= command.length) return null;
        const next = command[i + 1]!;
        if (next !== "\n") text += next;
        i += 2;
        continue;
      }
      text += ch;
      i++;
    }
    tokens.push({ text, start, end: i });
  }

  return tokens;
}

function isAssignmentWord(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

/** Reserved words that can open a compound-command segment, e.g. `do` in `for …; do tool …`. */
const LEADING_SHELL_KEYWORDS = new Set(["!", "{", "do", "then", "else", "elif", "if", "while", "until"]);
const TIMEOUT_OPTIONS_WITH_VALUE = new Set(["-k", "-s", "--kill-after", "--signal"]);

/** Index of the command after `timeout [options] DURATION`, or null if it is not one. */
function unwrapTimeout(tokens: ShellToken[], start: number): number | null {
  let i = start + 1;
  while (i < tokens.length && tokens[i]!.text.startsWith("-")) {
    const option = tokens[i]!.text;
    i += TIMEOUT_OPTIONS_WITH_VALUE.has(option) ? 2 : 1;
    if (option === "--") break;
  }
  return i < tokens.length && /^\d+(?:\.\d+)?[smhd]?$/.test(tokens[i]!.text) ? i + 1 : null;
}

/** Mirrors the transparent wrappers understood by the TUI's Bash renderer. */
function executableTokenIndex(tokens: ShellToken[]): number | null {
  let i = 0;
  while (i < tokens.length && LEADING_SHELL_KEYWORDS.has(tokens[i]!.text)) i++;
  while (i < tokens.length && isAssignmentWord(tokens[i]!.text)) i++;

  for (;;) {
    if (i >= tokens.length) return null;
    const token = tokens[i]!.text;
    if (token === "timeout") {
      const next = unwrapTimeout(tokens, i);
      if (next == null) return null;
      i = next;
      continue;
    }
    if (token === "env") {
      i++;
      while (i < tokens.length && tokens[i]!.text.startsWith("-")) {
        if (tokens[i]!.text === "--") {
          i++;
          break;
        }
        i++;
      }
      while (i < tokens.length && isAssignmentWord(tokens[i]!.text)) i++;
      continue;
    }
    if (token === "command") {
      i++;
      let introspectionOnly = false;
      while (i < tokens.length && tokens[i]!.text.startsWith("-")) {
        if (/^-[^-]*[vV]/.test(tokens[i]!.text)) introspectionOnly = true;
        i++;
      }
      if (introspectionOnly) return null;
      continue;
    }
    if (token === "time") {
      i++;
      while (i < tokens.length && tokens[i]!.text.startsWith("-")) i++;
      continue;
    }
    if (token === "nohup") {
      i++;
      continue;
    }
    if (token === "nice") {
      i++;
      if (tokens[i]?.text === "-n") i += 2;
      else if (tokens[i] && /^-?\d+$/.test(tokens[i]!.text)) i++;
      continue;
    }
    return i;
  }
}

function mayChangeShellWorkingDirectory(tokens: ShellToken[]): boolean {
  let i = 0;
  while (i < tokens.length && isAssignmentWord(tokens[i]!.text)) i++;
  for (;;) {
    const token = tokens[i]?.text;
    if (token === "command" || token === "builtin") {
      i++;
      while (i < tokens.length && tokens[i]!.text.startsWith("-")) i++;
      continue;
    }
    if (token === "time") {
      i++;
      while (i < tokens.length && tokens[i]!.text.startsWith("-")) i++;
      continue;
    }
    return token === "cd" || token === "pushd" || token === "popd" || token === "source" || token === "." || token === "eval";
  }
}

function containsPossibleWorkingDirectoryMutation(segment: string): boolean {
  return /(?:^|\s)(?:(?:command|builtin|time)\s+)*(?:cd|pushd|popd|source|\.|eval)(?=\s|$)/.test(segment);
}

function invocationOverridesWorkingDirectory(tokens: ShellToken[]): boolean {
  let i = 0;
  while (i < tokens.length && isAssignmentWord(tokens[i]!.text)) i++;
  if (tokens[i]?.text !== "env") return false;
  for (i += 1; i < tokens.length && tokens[i]!.text.startsWith("-"); i++) {
    const option = tokens[i]!.text;
    if (option === "-C" || option === "--chdir" || option.startsWith("--chdir=")) return true;
    if (option === "--") break;
  }
  return false;
}

function isStaticExplicitPath(path: string, rawToken: string): boolean {
  return path.includes("/")
    && !path.startsWith("~")
    && !DYNAMIC_PATH_CHARACTER.test(rawToken)
    && !CONTROL_CHARACTER.test(path);
}

/** `~/…` written unquoted: expands to the home directory every shell would use. */
function expandHomePrefix(path: string, rawToken: string, home: string): string | null {
  if (!rawToken.startsWith("~/")) return null;
  const rest = path.slice(2);
  return DYNAMIC_PATH_CHARACTER.test(rawToken.slice(2)) || CONTROL_CHARACTER.test(rest) ? null : join(home, rest);
}

/** The literal path a static word names: a plain path or an unquoted `~/…`, never an expansion. */
function staticPathWord(path: string, rawToken: string, home: string): string | null {
  const expanded = expandHomePrefix(path, rawToken, home);
  if (expanded) return expanded;
  return isStaticExplicitPath(path, rawToken) ? path : null;
}

const VARIABLE_REFERENCE = /^"?\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})"?$/;
/** `NAME=$(command -v tool || echo /path/to/tool)`: the tool on PATH, else that path to it. */
const COMMAND_V_FALLBACK = /^([A-Za-z_][A-Za-z0-9_]*)=\$\(\s*command\s+-v\s+([A-Za-z0-9._+-]+)(?:\s+2>\s*\/dev\/null)?\s*\|\|\s*echo\s+(\S+)\s*\)$/;

/**
 * Track `NAME=value` segments so `NAME=/path/tool; $NAME …` resolves. Only a
 * value that names one static path is kept; a variable assigned two different
 * values, or anything dynamic, is unresolvable so presentation never guesses.
 */
function recordShellAssignment(segment: string, variables: Map<string, string | null>, home: string): void {
  const text = segment.trim().replace(/^export\s+/, "");
  const fallback = COMMAND_V_FALLBACK.exec(text);
  if (fallback) {
    const [, name, tool, rawPath] = fallback as unknown as [string, string, string, string];
    const word = tokenizeSimpleShellCommand(rawPath)?.[0];
    const path = word ? staticPathWord(word.text, rawPath, home) : null;
    setShellVariable(variables, name, path && basename(path) === tool ? path : null);
    return;
  }

  const tokens = tokenizeSimpleShellCommand(text);
  if (tokens?.[0]?.text === "for" && tokens[1]) {
    setShellVariable(variables, tokens[1].text, null);
    return;
  }
  if (!tokens?.length || !tokens.every((token) => isAssignmentWord(token.text))) {
    // An assignment the tokenizer cannot read (command substitution, …) is dynamic.
    const name = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(text)?.[1];
    if (name && !tokens) setShellVariable(variables, name, null);
    return;
  }
  for (const token of tokens) {
    const raw = text.slice(token.start, token.end);
    const equals = token.text.indexOf("=");
    const name = token.text.slice(0, equals);
    const rawValue = raw.slice(raw.indexOf("=") + 1);
    setShellVariable(variables, name, staticPathWord(token.text.slice(equals + 1), rawValue, home));
  }
}

function setShellVariable(variables: Map<string, string | null>, name: string, value: string | null): void {
  variables.set(name, variables.has(name) && variables.get(name) !== value ? null : value);
}

/** Path an executable word runs, if it is a static path or a variable holding one. */
function resolveExecutableWord(
  word: string,
  rawWord: string,
  variables: ReadonlyMap<string, string | null>,
  home: string,
): string | null {
  const reference = VARIABLE_REFERENCE.exec(rawWord);
  if (reference) return variables.get(reference[1] ?? reference[2]!) ?? null;
  return staticPathWord(word, rawWord, home);
}

const COMPOUND_OPENERS = new Set(["for", "while", "until", "if", "select", "case", "{"]);
const COMPOUND_CLOSERS = new Set(["done", "fi", "esac", "}"]);

/** `cd /absolute/dir` (or `~/dir`): a target CDPATH cannot redirect. */
function staticAbsoluteCdTarget(tokens: ShellToken[], commandPart: string, home: string): string | null {
  let i = 0;
  if (tokens[i]?.text === "builtin" || tokens[i]?.text === "command") i++;
  if (tokens[i]?.text !== "cd" || tokens.length !== i + 2) return null;
  const target = tokens[i + 1]!;
  const raw = commandPart.slice(target.start, target.end);
  const path = staticPathWord(target.text, raw, home);
  return path && isAbsolute(path) ? resolve(path) : null;
}

/**
 * Explicit-path executables a Bash command runs, in order. Each segment is
 * resolved independently so a script that runs several tools styles each one.
 */
function findExplicitExecutables(rawCommand: string, initialCwd: string, home: string): ExecutableCandidate[] {
  const command = rawCommand ? stripHeredocBodies(rawCommand) : null;
  if (!command) return [];

  const candidates: ExecutableCandidate[] = [];
  const seenCommands = new Set<string>();
  const variables = new Map<string, string | null>();
  let cwd = resolve(initialCwd);
  let relativeCwdUncertain = false;
  // A `cd /dir &&` only holds while the && chain it starts continues: after
  // `;`, `||`, `&` or a newline the next command may run where cd failed.
  // Separators inside a compound command it chains to (`cd /dir && for …;
  // do …; done`) do not end it.
  let cwdChainDepth: number | null = null;
  let compoundDepth = 0;
  let previousSeparator = "";

  for (const segment of splitTopLevelShellSegments(command)) {
    if (
      cwdChainDepth !== null
      && compoundDepth <= cwdChainDepth
      && !["&&", "|", "|&"].includes(previousSeparator)
    ) {
      relativeCwdUncertain = true;
      cwdChainDepth = null;
    }
    previousSeparator = segment.separator;
    const firstWord = /^\s*(\S+)/.exec(segment.text)?.[1];
    if (firstWord && COMPOUND_OPENERS.has(firstWord)) compoundDepth++;
    else if (firstWord && COMPOUND_CLOSERS.has(firstWord)) compoundDepth = Math.max(0, compoundDepth - 1);
    const possibleWorkingDirectoryMutation = containsPossibleWorkingDirectoryMutation(segment.text);
    // Before redirection splitting: `$(command -v tool 2>/dev/null || …)` holds a `>`.
    recordShellAssignment(segment.text, variables, home);
    const commandPart = splitAtFirstTopLevelRedirection(segment.text);
    const tokens = tokenizeSimpleShellCommand(commandPart);
    const staticCd = tokens && segment.separator === "&&" ? staticAbsoluteCdTarget(tokens, commandPart, home) : null;
    if (staticCd) {
      cwd = staticCd;
      relativeCwdUncertain = false;
      cwdChainDepth = compoundDepth;
      continue;
    }
    if (!tokens?.length) {
      if (possibleWorkingDirectoryMutation) relativeCwdUncertain = true;
      continue;
    }
    const changesWorkingDirectory = mayChangeShellWorkingDirectory(tokens);
    const invocationCwdUncertain = invocationOverridesWorkingDirectory(tokens);
    const commandIndex = executableTokenIndex(tokens);
    if (commandIndex == null) {
      if (changesWorkingDirectory) relativeCwdUncertain = true;
      continue;
    }

    const token = tokens[commandIndex]!;
    const rawExecutable = commandPart.slice(token.start, token.end);
    const executable = resolveExecutableWord(token.text, rawExecutable, variables, home);
    const commandName = executable ? basename(executable) : "";
    const eligible = executable !== null
      && commandName.length > 0
      && commandName !== "."
      && commandName !== ".."
      && ((!relativeCwdUncertain && !invocationCwdUncertain) || isAbsolute(executable))
      && !seenCommands.has(rawExecutable);
    if (eligible) {
      candidates.push({ cmd: rawExecutable, executablePath: resolve(cwd, executable) });
      seenCommands.add(rawExecutable);
      if (candidates.length >= MAX_PRESENTATION_STYLES) break;
    }
    if (changesWorkingDirectory || possibleWorkingDirectoryMutation) relativeCwdUncertain = true;
  }

  return candidates;
}

function validDisplay(display: { label?: unknown; color?: unknown } | undefined): ManifestDisplay | null {
  const label = typeof display?.label === "string" ? display.label.trim() : "";
  const color = display?.color;
  if (
    !label
    || label.length > MAX_LABEL_LENGTH
    || CONTROL_CHARACTER.test(label)
    || typeof color !== "string"
    || !HEX_COLOR.test(color)
  ) return null;
  return { label, color };
}

async function parseManifest(manifestPath: string): Promise<ParsedManifest | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // O_NONBLOCK prevents a manifest path replaced by a FIFO from stalling the
    // invocation. Read through this one descriptor so replacement races cannot
    // bypass the byte limit between a stat and a separate readFile call.
    handle = await open(manifestPath, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) return null;

    const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > MAX_MANIFEST_BYTES) {
      log("warn", `helper-tool-manifest: ${manifestPath} exceeds ${MAX_MANIFEST_BYTES} bytes — ignoring`);
      return null;
    }

    const parsed = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as {
      version?: unknown;
      bin?: unknown;
      display?: { label?: unknown; color?: unknown };
    };
    const display = validDisplay(parsed.display);
    if (basename(manifestPath) === TOOL_MANIFEST_NAME) {
      // Only the display and bin of a full tool manifest matter here.
      if (!display || typeof parsed.bin !== "string" || !parsed.bin) return null;
      return { ...display, binPath: resolve(dirname(manifestPath), parsed.bin) };
    }
    if (parsed.version !== 1 || !display) {
      log("warn", `helper-tool-manifest: invalid manifest at ${manifestPath} — ignoring`);
      return null;
    }
    return display;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    const message = err instanceof Error ? err.message : String(err);
    log("warn", `helper-tool-manifest: failed to read ${manifestPath}: ${message}`);
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function cacheManifest(manifestPath: string, manifest: ParsedManifest | null): void {
  manifestCache.delete(manifestPath);
  manifestCache.set(manifestPath, { manifest, readAt: Date.now() });
  if (manifestCache.size > MAX_MANIFEST_CACHE_ENTRIES) {
    manifestCache.delete(manifestCache.keys().next().value!);
  }
}

/** Read one manifest within the lookup deadline; undefined means unknown (busy or timed out). */
async function readManifestWithinDeadline(manifestPath: string): Promise<ParsedManifest | null | undefined> {
  // Timed-out filesystem operations cannot be portably cancelled on every
  // supported filesystem. Keep them globally bounded so repeated commands can
  // never exhaust the daemon's filesystem workers or descriptors.
  if (activeManifestReads >= MAX_CONCURRENT_MANIFEST_READS) return undefined;
  activeManifestReads++;
  const read = parseManifest(manifestPath)
    .then((manifest) => {
      cacheManifest(manifestPath, manifest);
      return manifest;
    })
    .finally(() => { activeManifestReads--; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolveTimeout) => {
    timer = setTimeout(() => {
      log("warn", `helper-tool-manifest: lookup timed out at ${manifestPath} — ignoring`);
      resolveTimeout(undefined);
    }, MANIFEST_LOOKUP_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Manifests that can style an executable, most specific first: a helper
 * `exo-manifest.json` beside it, then a full tool `manifest.json` beside it or
 * one directory up (the `bin/` layout) whose `bin` is exactly that executable.
 */
function manifestPathsFor(executablePath: string): string[] {
  const dir = dirname(executablePath);
  return [join(dir, MANIFEST_NAME), join(dir, TOOL_MANIFEST_NAME), join(dirname(dir), TOOL_MANIFEST_NAME)];
}

function displayFor(manifest: ParsedManifest | null | undefined, executablePath: string): ManifestDisplay | null {
  if (!manifest || (manifest.binPath !== undefined && manifest.binPath !== executablePath)) return null;
  return { label: manifest.label, color: manifest.color };
}

async function lookupDisplay(executablePath: string): Promise<ManifestDisplay | null> {
  for (const manifestPath of manifestPathsFor(executablePath)) {
    const manifest = await readManifestWithinDeadline(manifestPath);
    // An unknown manifest might have styled the tool: never fall through past it.
    if (manifest === undefined) return null;
    const display = displayFor(manifest, executablePath);
    if (display) return display;
  }
  return null;
}

function refreshManifestInBackground(manifestPath: string): void {
  if (manifestRefreshes.has(manifestPath)) return;
  manifestRefreshes.add(manifestPath);
  void readManifestWithinDeadline(manifestPath).finally(() => manifestRefreshes.delete(manifestPath));
}

/** Cached-only lookup; misses and stale entries are read in the background for later calls. */
function lookupCachedDisplay(executablePath: string): ManifestDisplay | null {
  for (const manifestPath of manifestPathsFor(executablePath)) {
    const cached = manifestCache.get(manifestPath);
    if (!cached || Date.now() - cached.readAt > MANIFEST_CACHE_TTL_MS) refreshManifestInBackground(manifestPath);
    if (!cached) return null;
    const display = displayFor(cached.manifest, executablePath);
    if (display) return display;
  }
  return null;
}

function toPresentation(candidates: ExecutableCandidate[], displays: Array<ManifestDisplay | null>): ToolCallPresentation | undefined {
  const styles: ExternalToolStyle[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const display = displays[index];
    if (display) styles.push({ cmd: candidate.cmd, label: display.label, color: display.color });
  }
  return styles.length > 0 ? { bashStyles: styles } : undefined;
}

/** Resolve presentation metadata for direct-path helper and external tools in one Bash call. */
export async function resolveHelperToolPresentation(
  command: string,
  initialCwd: string = process.cwd(),
  home: string = homedir(),
): Promise<ToolCallPresentation | undefined> {
  const candidates = findExplicitExecutables(command, initialCwd, home);
  const displays = await Promise.all(candidates.map((candidate) => lookupDisplay(candidate.executablePath)));
  return toPresentation(candidates, displays);
}

/**
 * Synchronous variant for providers that report tool calls from a synchronous
 * stream (Claude Code). It answers from manifests already read and reads the
 * rest in the background, so a tool's first call after a manifest appears may
 * still render as plain Bash. warmToolManifestCache() pre-reads the known tools.
 */
export function resolveHelperToolPresentationFromCache(
  command: string,
  initialCwd: string = process.cwd(),
  home: string = homedir(),
): ToolCallPresentation | undefined {
  const candidates = findExplicitExecutables(command, initialCwd, home);
  return toPresentation(candidates, candidates.map((candidate) => lookupCachedDisplay(candidate.executablePath)));
}

/** Shell command of a Bash-like tool call: Exocortex `bash`, Claude Code `Bash`, OpenAI `exec_command`. */
function bashCommandOf(toolName: string, input: Record<string, unknown>): string | null {
  if (process.platform === "win32") return null;
  const command = toolName === "bash" || toolName === "Bash" ? input.command
    : toolName === "exec_command" ? input.cmd
    : undefined;
  return typeof command === "string" ? command : null;
}

/** Agent-loop presenter for any native tool call. */
export async function resolveToolCallPresentation(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string = process.cwd(),
  home: string = homedir(),
): Promise<ToolCallPresentation | undefined> {
  const command = bashCommandOf(toolName, input);
  return command === null ? undefined : resolveHelperToolPresentation(command, cwd, home);
}

/** Synchronous presenter for a provider's own tool calls; see resolveHelperToolPresentationFromCache. */
export function resolveToolCallPresentationFromCache(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string = process.cwd(),
  home: string = homedir(),
): ToolCallPresentation | undefined {
  const command = bashCommandOf(toolName, input);
  return command === null ? undefined : resolveHelperToolPresentationFromCache(command, cwd, home);
}

/**
 * Pre-read the manifests of every tool directory under the given roots (e.g.
 * external-tools/ and helper-tools/) so the synchronous presenter knows them
 * from the first call. Best-effort; failures only mean later cache misses.
 */
export async function warmToolManifestCache(roots: readonly string[]): Promise<void> {
  const executables: string[] = [];
  for (const root of roots) {
    const toolDirs = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of toolDirs) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      for (const dir of [join(root, entry.name), join(root, entry.name, "bin")]) {
        const files = await readdir(dir).catch(() => []);
        for (const file of files) {
          const path = join(dir, file);
          const info = await stat(path).catch(() => null);
          if (info?.isFile() && (info.mode & 0o111) !== 0) executables.push(path);
        }
      }
    }
  }
  // Sequential: the manifest reads share one small concurrency budget with live calls.
  for (const executable of executables) await lookupDisplay(executable);
}

/** Forget cached manifests (tests). */
export function clearToolManifestCacheForTest(): void {
  manifestCache.clear();
  manifestRefreshes.clear();
}
