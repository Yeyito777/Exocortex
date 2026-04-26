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
    }
  | {
      /**
       * Direct subcommand with a freeform positional argument.
       *
       * The index is zero-based among non-option positional arguments after the
       * subcommand. Option flags are skipped; flags listed in flagsWithValues also
       * skip their following value, and --flag=value is skipped as one token.
       */
      subcommand: string;
      kind: "positional";
      index: number;
      flagsWithValues?: string[];
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

function looksLikeOptionToken(text: string): boolean {
  return /^--?[A-Za-z]/.test(text);
}

function optionNameForInlineAssignment(text: string): string | null {
  const eq = text.indexOf("=");
  if (eq <= 0) return null;
  const name = text.slice(0, eq);
  return looksLikeOptionToken(name) ? name : null;
}

function getLiteralArgRules(shell: ManifestShell | undefined): ManifestShellLiteralArg[] {
  return shell?.literalArgs ?? [];
}

function describeLiteralArgRule(toolName: string, rule: ManifestShellLiteralArg): string {
  if (rule.kind === "tail") {
    return `\`${toolName} ${rule.subcommand}\` (final argument literal)`;
  }
  if (rule.kind === "positional") {
    return `\`${toolName} ${rule.subcommand}\` (positional argument ${rule.index} literal)`;
  }
  return `\`${toolName} ${rule.subcommand} ${rule.flag} ...\` (${rule.flag} value literal)`;
}

interface TokenReplacement {
  start: number;
  end: number;
  text: string;
}

function getInlineFlagValueReplacement(token: ShellToken, flag: string): TokenReplacement | null {
  const prefix = `${flag}=`;
  if (!token.text.startsWith(prefix)) return null;
  const value = token.text.slice(prefix.length);
  return { start: token.start, end: token.end, text: `${flag}=${quoteBashLiteral(value)}` };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isValidLiteralArgRule(value: unknown): value is ManifestShellLiteralArg {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  const rule = value as { subcommand?: unknown; kind?: unknown; flag?: unknown; index?: unknown; flagsWithValues?: unknown };
  if (!isNonEmptyString(rule.subcommand)) return false;
  if (rule.kind === "tail") return true;
  if (rule.kind === "flag") return isNonEmptyString(rule.flag);
  if (rule.kind === "positional") {
    if (!isNonNegativeInteger(rule.index)) return false;
    return rule.flagsWithValues === undefined || isNonEmptyStringArray(rule.flagsWithValues);
  }
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

function findPositionalToken(tokens: ShellToken[], startIndex: number, index: number, flagsWithValues: string[] | undefined): ShellToken | null {
  const valueFlags = new Set(flagsWithValues ?? []);
  let positionalIndex = 0;
  let afterEndOfOptions = false;

  for (let i = startIndex; i < tokens.length; i++) {
    const token = tokens[i]!;

    if (!afterEndOfOptions && token.text === "--") {
      afterEndOfOptions = true;
      continue;
    }

    if (!afterEndOfOptions && looksLikeOptionToken(token.text)) {
      const inlineOptionName = optionNameForInlineAssignment(token.text);
      if (inlineOptionName && valueFlags.has(inlineOptionName)) continue;
      if (valueFlags.has(token.text) && i + 1 < tokens.length) i++;
      continue;
    }

    if (positionalIndex === index) return token;
    positionalIndex++;
  }

  return null;
}

function addReplacement(replacements: TokenReplacement[], replacement: TokenReplacement): void {
  if (replacements.some((existing) => replacement.start < existing.end && existing.start < replacement.end)) return;
  replacements.push(replacement);
}

function applyReplacements(segment: string, replacements: TokenReplacement[]): string {
  if (replacements.length === 0) return segment;
  let rewritten = segment;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    rewritten = rewritten.slice(0, replacement.start) + replacement.text + rewritten.slice(replacement.end);
  }
  return rewritten;
}

function rewriteSimpleExternalToolShellSegment(segment: string, tools: ShellToolLike[]): string {
  const { commandPart, redirectionSuffix } = splitAtFirstTopLevelRedirection(segment);
  const tokens = tokenizeSimpleShellCommand(commandPart);
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
  const replacements: TokenReplacement[] = [];

  for (const rule of rules) {
    if (rule.subcommand !== subcommand) continue;

    if (rule.kind === "tail") {
      if (subcommandArgsStart >= tokens.length) continue;
      const lastToken = tokens[tokens.length - 1]!;
      addReplacement(replacements, { start: lastToken.start, end: lastToken.end, text: quoteBashLiteral(lastToken.text) });
      continue;
    }

    if (rule.kind === "positional") {
      const token = findPositionalToken(tokens, subcommandArgsStart, rule.index, rule.flagsWithValues);
      if (!token) continue;
      addReplacement(replacements, { start: token.start, end: token.end, text: quoteBashLiteral(token.text) });
      continue;
    }

    for (let i = subcommandArgsStart; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token.text === rule.flag) {
        const valueToken = tokens[i + 1];
        if (!valueToken || looksLikeOptionToken(valueToken.text)) continue;
        addReplacement(replacements, { start: valueToken.start, end: valueToken.end, text: quoteBashLiteral(valueToken.text) });
        break;
      }

      const inlineReplacement = getInlineFlagValueReplacement(token, rule.flag);
      if (inlineReplacement !== null) {
        addReplacement(replacements, inlineReplacement);
        break;
      }
    }
  }

  return applyReplacements(commandPart, replacements) + redirectionSuffix;
}

export function rewriteExternalToolShellCommandForTools(command: string, tools: ShellToolLike[]): string {
  const segments = splitTopLevelShellSegments(command);
  return segments
    .map((segment) => rewriteSimpleExternalToolShellSegment(segment.text, tools) + segment.separator)
    .join("");
}
