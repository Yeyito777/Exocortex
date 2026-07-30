/**
 * Shell-aware injection of daemon-borrowed authentication arguments.
 * Opaque tool payloads travel on stdin and are never parsed or rewritten here.
 */

interface ShellToken {
  text: string;
  start: number;
  end: number;
}

interface ShellToolLike {
  manifest: {
    name: string;
  };
}

type AuthArgResolver = (tool: ShellToolLike) => Promise<string[]>;

interface ShellSegment {
  text: string;
  separator: string;
}

const UNSUPPORTED_SHELL_CHARS = new Set(["<", ">", "(", ")", "`"]);

function isShellWhitespace(ch: string): boolean {
  return /\s/.test(ch);
}

function splitTopLevelShellSegments(command: string): ShellSegment[] {
  const segments: ShellSegment[] = [];
  let start = 0;
  let i = 0;
  let quote: "'" | '"' | null = null;

  while (i < command.length) {
    const ch = command[i]!;

    if (quote === "'") {
      if (ch === "'") quote = null;
      i++;
      continue;
    }

    if (quote === '"') {
      if (ch === "\\" && i + 1 < command.length) {
        i += 2;
        continue;
      }
      if (ch === '"') quote = null;
      i++;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      i++;
      continue;
    }

    if (ch === "\\" && i + 1 < command.length) {
      i += 2;
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
    if (separator) {
      segments.push({ text: command.slice(start, i), separator });
      i += separator.length;
      start = i;
      continue;
    }

    i++;
  }

  segments.push({ text: command.slice(start), separator: "" });
  return segments;
}

function tokenizeSimpleShellCommand(command: string): ShellToken[] | null {
  const tokens: ShellToken[] = [];
  const len = command.length;
  let i = 0;

  while (i < len) {
    while (i < len && isShellWhitespace(command[i]!)) i++;
    if (i >= len) break;
    if (UNSUPPORTED_SHELL_CHARS.has(command[i]!)) return null;

    const start = i;
    let text = "";

    while (i < len) {
      const ch = command[i]!;
      if (isShellWhitespace(ch)) break;
      if (UNSUPPORTED_SHELL_CHARS.has(ch)) return null;

      if (ch === "'") {
        i++;
        while (i < len && command[i] !== "'") {
          text += command[i]!;
          i++;
        }
        if (i >= len) return null;
        i++;
        continue;
      }

      if (ch === '"') {
        i++;
        let closed = false;
        while (i < len) {
          const inner = command[i]!;
          if (inner === '"') {
            closed = true;
            i++;
            break;
          }
          if (inner === "\\") {
            if (i + 1 >= len) return null;
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
            text += "\\";
            i++;
            continue;
          }
          text += inner;
          i++;
        }
        if (!closed) return null;
        continue;
      }

      if (ch === "\\") {
        if (i + 1 >= len) return null;
        const next = command[i + 1]!;
        if (next === "\n") {
          i += 2;
          continue;
        }
        text += next;
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

function quoteBashLiteral(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function splitAtFirstTopLevelRedirection(segment: string): { commandPart: string; redirectionSuffix: string } {
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;

    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }

    if (quote === '"') {
      if (ch === "\\" && i + 1 < segment.length) {
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

    if (ch === "\\" && i + 1 < segment.length) {
      i++;
      continue;
    }

    if (ch !== "<" && ch !== ">") continue;

    let redirectionStart = i;
    if (ch === ">" && i > 0 && segment[i - 1] === "&") {
      redirectionStart = i - 1;
    } else {
      while (redirectionStart > 0 && /[0-9]/.test(segment[redirectionStart - 1]!)) {
        redirectionStart--;
      }
    }

    return {
      commandPart: segment.slice(0, redirectionStart),
      redirectionSuffix: segment.slice(redirectionStart),
    };
  }

  return { commandPart: segment, redirectionSuffix: "" };
}

function isEnvAssignmentToken(text: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(text);
}

function rewriteSimpleExternalToolShellSegmentWithAuthArgs(
  segment: string,
  tools: ShellToolLike[],
  authArgsByToolName: Map<string, string[]> = new Map(),
): string {
  const { commandPart, redirectionSuffix } = splitAtFirstTopLevelRedirection(segment);
  const tokens = tokenizeSimpleShellCommand(commandPart);
  if (!tokens) return segment;

  let commandIndex = 0;
  while (commandIndex < tokens.length && isEnvAssignmentToken(tokens[commandIndex]!.text)) {
    commandIndex++;
  }

  if (tokens.length - commandIndex < 1) return segment;

  const tool = tools.find((entry) => entry.manifest.name === tokens[commandIndex]!.text);
  if (!tool) return segment;

  const authArgs = authArgsByToolName.get(tool.manifest.name) ?? [];
  if (authArgs.length === 0) return segment;

  const insertion = authArgs.map(quoteBashLiteral).join(" ");
  const commandToken = tokens[commandIndex]!;
  return commandPart.slice(0, commandToken.end)
    + ` ${insertion}`
    + commandPart.slice(commandToken.end)
    + redirectionSuffix;
}

function toolsReferencedByCommand(command: string, tools: ShellToolLike[]): ShellToolLike[] {
  const segments = splitTopLevelShellSegments(command);
  const seen = new Set<string>();
  const referenced: ShellToolLike[] = [];

  for (const segment of segments) {
    const { commandPart } = splitAtFirstTopLevelRedirection(segment.text);
    const tokens = tokenizeSimpleShellCommand(commandPart);
    if (!tokens) continue;

    let commandIndex = 0;
    while (commandIndex < tokens.length && isEnvAssignmentToken(tokens[commandIndex]!.text)) commandIndex++;
    const tool = tools.find((entry) => entry.manifest.name === tokens[commandIndex]?.text);
    if (!tool || seen.has(tool.manifest.name)) continue;
    seen.add(tool.manifest.name);
    referenced.push(tool);
  }

  return referenced;
}

export async function rewriteExternalToolShellCommandForToolsWithAuth(
  command: string,
  tools: ShellToolLike[],
  authArgResolver?: AuthArgResolver,
): Promise<string> {
  const authArgsByToolName = new Map<string, string[]>();
  if (authArgResolver) {
    await Promise.all(toolsReferencedByCommand(command, tools).map(async (tool) => {
      const authArgs = await authArgResolver(tool);
      if (authArgs.length > 0) authArgsByToolName.set(tool.manifest.name, authArgs);
    }));
  }

  const segments = splitTopLevelShellSegments(command);
  return segments
    .map((segment) => rewriteSimpleExternalToolShellSegmentWithAuthArgs(segment.text, tools, authArgsByToolName) + segment.separator)
    .join("");
}
