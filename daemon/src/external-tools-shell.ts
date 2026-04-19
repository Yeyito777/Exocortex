export type ManifestShellLiteralArg =
  | {
      /** Direct subcommand whose final positional argument is freeform text. */
      subcommand: string;
      kind: "tail";
    }
  | {
      /** Direct subcommand with a flag whose value is freeform text. */
      subcommand: string;
      kind: "flag";
      flag: string;
    };

export interface ManifestShell {
  /**
   * Precise literal-argument rewrite rules for eligible top-level tool invocations.
   */
  literalArgs?: ManifestShellLiteralArg[];
}

interface ShellToken {
  text: string;
  start: number;
  end: number;
}

interface ShellToolLike {
  manifest: {
    name: string;
    shell?: ManifestShell;
  };
}

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

    const separator = ch === ";"
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

function isEnvAssignmentToken(text: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(text);
}

function looksLikeOptionToken(text: string): boolean {
  return /^--?[A-Za-z]/.test(text);
}

function getLiteralArgRules(shell: ManifestShell | undefined): ManifestShellLiteralArg[] {
  return shell?.literalArgs ?? [];
}

function describeLiteralArgRule(toolName: string, rule: ManifestShellLiteralArg): string {
  if (rule.kind === "tail") {
    return `\`${toolName} ${rule.subcommand}\` (final argument literal)`;
  }
  return `\`${toolName} ${rule.subcommand} ${rule.flag} ...\` (${rule.flag} value literal)`;
}

function rewriteFlagValueToken(command: string, token: ShellToken, flag: string): string | null {
  const prefix = `${flag}=`;
  if (!token.text.startsWith(prefix)) return null;
  const value = token.text.slice(prefix.length);
  return command.slice(0, token.start) + `${flag}=${quoteBashLiteral(value)}` + command.slice(token.end);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidLiteralArgRule(value: unknown): value is ManifestShellLiteralArg {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  const rule = value as { subcommand?: unknown; kind?: unknown; flag?: unknown };
  if (!isNonEmptyString(rule.subcommand)) return false;
  if (rule.kind === "tail") return true;
  if (rule.kind === "flag") return isNonEmptyString(rule.flag);
  return false;
}

export function isValidShellConfig(value: unknown): value is ManifestShell {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const shell = value as { literalArgs?: unknown };
  return shell.literalArgs === undefined || (Array.isArray(shell.literalArgs) && shell.literalArgs.every(isValidLiteralArgRule));
}

export function getShellConfigHint(toolName: string, shell?: ManifestShell): string | null {
  const rules = getLiteralArgRules(shell);
  if (rules.length === 0) return null;

  const refs = rules.map((rule) => describeLiteralArgRule(toolName, rule)).join(", ");
  return `For ${refs}, freeform text arguments are treated literally by the bash harness, so markdown/code text does not need manual shell escaping.`;
}

function rewriteSimpleExternalToolShellSegment(segment: string, tools: ShellToolLike[]): string {
  const tokens = tokenizeSimpleShellCommand(segment);
  if (!tokens) return segment;

  let commandIndex = 0;
  while (commandIndex < tokens.length && isEnvAssignmentToken(tokens[commandIndex]!.text)) {
    commandIndex++;
  }

  if (tokens.length - commandIndex < 2) return segment;

  const tool = tools.find((entry) => entry.manifest.name === tokens[commandIndex]!.text);
  if (!tool) return segment;

  const rules = getLiteralArgRules(tool.manifest.shell);
  if (rules.length === 0) return segment;

  const subcommand = tokens[commandIndex + 1]!.text;
  const subcommandArgsStart = commandIndex + 2;

  for (const rule of rules) {
    if (rule.subcommand !== subcommand) continue;

    if (rule.kind === "tail") {
      if (subcommandArgsStart >= tokens.length) continue;
      const lastToken = tokens[tokens.length - 1]!;
      const quotedTail = quoteBashLiteral(lastToken.text);
      return segment.slice(0, lastToken.start) + quotedTail + segment.slice(lastToken.end);
    }

    for (let i = subcommandArgsStart; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token.text === rule.flag) {
        const valueToken = tokens[i + 1];
        if (!valueToken || looksLikeOptionToken(valueToken.text)) continue;
        return segment.slice(0, valueToken.start) + quoteBashLiteral(valueToken.text) + segment.slice(valueToken.end);
      }

      const rewrittenInlineValue = rewriteFlagValueToken(segment, token, rule.flag);
      if (rewrittenInlineValue !== null) return rewrittenInlineValue;
    }
  }

  return segment;
}

export function rewriteExternalToolShellCommandForTools(command: string, tools: ShellToolLike[]): string {
  const segments = splitTopLevelShellSegments(command);
  return segments
    .map((segment) => rewriteSimpleExternalToolShellSegment(segment.text, tools) + segment.separator)
    .join("");
}
