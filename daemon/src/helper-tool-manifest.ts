import { constants } from "fs";
import { open } from "fs/promises";
import { basename, dirname, isAbsolute, resolve } from "path";
import type { ExternalToolStyle, ToolCallPresentation } from "@exocortex/shared/messages";
import { log } from "./log";

const MANIFEST_NAME = "exo-manifest.json";
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_PRESENTATION_STYLES = 4;
const MAX_LABEL_LENGTH = 64;
const MANIFEST_LOOKUP_TIMEOUT_MS = 100;
const MAX_CONCURRENT_MANIFEST_READS = 4;
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

let activeManifestReads = 0;

function isShellWhitespace(ch: string): boolean {
  return /\s/.test(ch);
}

function startsShellComment(command: string, index: number, segmentStart: number): boolean {
  return command[index] === "#"
    && (index === segmentStart || isShellWhitespace(command[index - 1] ?? ""));
}

/**
 * Helper tool lookup stays deliberately conservative. Heredoc bodies
 * are shell data rather than commands, and correctly pairing all heredocs would
 * turn this presentation feature into a second shell parser. Skip the complete
 * call instead of ever styling a command-looking line inside a heredoc body.
 */
function hasTopLevelHeredoc(command: string): boolean {
  let quote: "'" | '"' | null = null;
  let comment = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (comment) {
      if (ch === "\n") comment = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < command.length) i++;
      else if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      i++;
      continue;
    }
    if (startsShellComment(command, i, 0)) {
      comment = true;
      continue;
    }
    if (ch === "<" && command[i + 1] === "<") {
      if (command[i + 2] === "<") {
        i += 2;
        continue;
      }
      return true;
    }
  }

  return false;
}

function splitTopLevelShellSegments(command: string): ShellSegment[] {
  const segments: ShellSegment[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let comment = false;

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

/** Mirrors the transparent wrappers understood by the TUI's Bash renderer. */
function executableTokenIndex(tokens: ShellToken[]): number | null {
  let i = 0;
  while (i < tokens.length && isAssignmentWord(tokens[i]!.text)) i++;

  for (;;) {
    if (i >= tokens.length) return null;
    const token = tokens[i]!.text;
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

async function parseManifest(manifestPath: string): Promise<ManifestDisplay | null> {
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
      display?: { label?: unknown; color?: unknown };
    };
    const label = typeof parsed.display?.label === "string" ? parsed.display.label.trim() : "";
    const color = parsed.display?.color;
    if (
      parsed.version !== 1
      || !label
      || label.length > MAX_LABEL_LENGTH
      || CONTROL_CHARACTER.test(label)
      || typeof color !== "string"
      || !HEX_COLOR.test(color)
    ) {
      log("warn", `helper-tool-manifest: invalid manifest at ${manifestPath} — ignoring`);
      return null;
    }
    return { label, color };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    const message = err instanceof Error ? err.message : String(err);
    log("warn", `helper-tool-manifest: failed to read ${manifestPath}: ${message}`);
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function parseManifestWithinDeadline(manifestPath: string): Promise<ManifestDisplay | null> {
  // Timed-out filesystem operations cannot be portably cancelled on every
  // supported filesystem. Keep them globally bounded so repeated commands can
  // never exhaust the daemon's filesystem workers or descriptors.
  if (activeManifestReads >= MAX_CONCURRENT_MANIFEST_READS) return null;
  activeManifestReads++;
  const read = parseManifest(manifestPath).finally(() => { activeManifestReads--; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolveTimeout) => {
    timer = setTimeout(() => {
      log("warn", `helper-tool-manifest: lookup timed out at ${manifestPath} — ignoring`);
      resolveTimeout(null);
    }, MANIFEST_LOOKUP_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Resolve presentation metadata for direct-path helper tools in one Bash call. */
export async function resolveHelperToolPresentation(
  command: string,
  initialCwd: string = process.cwd(),
): Promise<ToolCallPresentation | undefined> {
  if (!command || hasTopLevelHeredoc(command)) return undefined;

  const candidates: Array<{ cmd: string; manifestPath: string }> = [];
  const seenCommands = new Set<string>();
  const cwd = resolve(initialCwd);
  let relativeCwdUncertain = false;

  for (const segment of splitTopLevelShellSegments(command)) {
    const possibleWorkingDirectoryMutation = containsPossibleWorkingDirectoryMutation(segment.text);
    const commandPart = splitAtFirstTopLevelRedirection(segment.text);
    const tokens = tokenizeSimpleShellCommand(commandPart);
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
    const executable = token.text;
    const rawExecutable = commandPart.slice(token.start, token.end);
    const commandName = basename(executable);
    const eligible = commandName.length > 0
      && commandName !== "."
      && commandName !== ".."
      && isStaticExplicitPath(executable, rawExecutable)
      && ((!relativeCwdUncertain && !invocationCwdUncertain) || isAbsolute(executable))
      && !seenCommands.has(rawExecutable);
    if (eligible) {
      const executablePath = resolve(cwd, executable);
      candidates.push({
        cmd: rawExecutable,
        manifestPath: resolve(dirname(executablePath), MANIFEST_NAME),
      });
      seenCommands.add(rawExecutable);
      if (candidates.length >= MAX_PRESENTATION_STYLES) break;
    }
    if (changesWorkingDirectory || possibleWorkingDirectoryMutation) relativeCwdUncertain = true;
  }

  const displays = await Promise.all(candidates.map((candidate) => parseManifestWithinDeadline(candidate.manifestPath)));
  const styles: ExternalToolStyle[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const display = displays[index];
    if (display) styles.push({ cmd: candidate.cmd, label: display.label, color: display.color });
  }
  return styles.length > 0 ? { bashStyles: styles } : undefined;
}

/** Agent-loop presenter for any native tool call. */
export async function resolveToolCallPresentation(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string = process.cwd(),
): Promise<ToolCallPresentation | undefined> {
  if (toolName !== "bash" || process.platform === "win32") return undefined;
  return typeof input.command === "string"
    ? resolveHelperToolPresentation(input.command, cwd)
    : undefined;
}
