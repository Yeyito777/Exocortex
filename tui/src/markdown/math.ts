import { latexToUnicode } from "@devhub-io/latex-to-unicode";
import type { WrapCopyLine } from "../textwrap";
import { sliceByWidth, termWidth } from "../textwidth";

/**
 * Terminal math rendering.
 *
 * A terminal cannot reproduce TeX's font metrics and stacked layout without
 * turning every equation into an image.  Instead, Exocortex renders delimited
 * TeX as compact Unicode math: commands become their mathematical glyphs,
 * scripts use Unicode super/subscripts, and structural forms use readable
 * terminal notation (for example `√(x)` and `(a + b)/c`).
 */

const ESCAPED_LEFT_BRACE = "\uE000";
const ESCAPED_RIGHT_BRACE = "\uE001";
const ESCAPED_AMPERSAND = "\uE002";
const FRAGMENT_START = "\uE003";
const FRAGMENT_END = "\uE004";

// The converter deliberately has a small core vocabulary.  These aliases cover
// notation commonly emitted by chat models and add spacing around binary
// operators, which is especially important in a monospace display.
const CUSTOM_MACROS: Record<string, string> = {
  land: " ∧ ",
  lor: " ∨ ",
  iff: " ⇔ ",
  implies: " ⇒ ",
  impliedby: " ⇐ ",
  not: "¬",
  neg: "¬",
  wedge: " ∧ ",
  vee: " ∨ ",
  Rightarrow: " ⇒ ",
  Leftarrow: " ⇐ ",
  Leftrightarrow: " ⇔ ",
  Longrightarrow: " ⇒ ",
  Longleftarrow: " ⇐ ",
  Longleftrightarrow: " ⇔ ",
  to: " → ",
  mapsto: " ↦ ",
  in: " ∈ ",
  notin: " ∉ ",
  ni: " ∋ ",
  le: " ≤ ",
  leq: " ≤ ",
  ge: " ≥ ",
  geq: " ≥ ",
  ne: " ≠ ",
  neq: " ≠ ",
  approx: " ≈ ",
  equiv: " ≡ ",
  sim: " ∼ ",
  simeq: " ≃ ",
  cong: " ≅ ",
  propto: " ∝ ",
  subset: " ⊂ ",
  subseteq: " ⊆ ",
  supset: " ⊃ ",
  supseteq: " ⊇ ",
  cup: " ∪ ",
  cap: " ∩ ",
  setminus: " ∖ ",
  times: " × ",
  cdot: " · ",
  div: " ÷ ",
  pm: " ± ",
  mp: " ∓ ",
  oplus: " ⊕ ",
  otimes: " ⊗ ",
  parallel: " ∥ ",
  perp: " ⟂ ",
  colon: ":",
  mid: " | ",
  vert: "|",
  Vert: "‖",
  langle: "⟨",
  rangle: "⟩",
  lceil: "⌈",
  rceil: "⌉",
  lfloor: "⌊",
  rfloor: "⌋",
  lim: "lim",
  limsup: "lim sup",
  liminf: "lim inf",
  min: "min",
  max: "max",
  sup: "sup",
  inf: "inf",
  argmin: "arg min",
  argmax: "arg max",
  sin: "sin",
  cos: "cos",
  tan: "tan",
  cot: "cot",
  sec: "sec",
  csc: "csc",
  arcsin: "arcsin",
  arccos: "arccos",
  arctan: "arctan",
  sinh: "sinh",
  cosh: "cosh",
  tanh: "tanh",
  log: "log",
  ln: "ln",
  exp: "exp",
  det: "det",
  gcd: "gcd",
  ker: "ker",
  Pr: "Pr",
  mod: " mod ",
  // Font commands have no faithful terminal equivalent. Preserve their content
  // rather than exposing the command name.
  mathbb: "",
  mathcal: "",
  mathscr: "",
  mathfrak: "",
  mathsf: "",
  mathtt: "",
};

interface GroupMatch {
  content: string;
  end: number;
}

function readBraceGroup(input: string, open: number): GroupMatch | null {
  if (input[open] !== "{") return null;
  let depth = 0;
  for (let i = open; i < input.length; i++) {
    if (input[i] === "\\") {
      i++;
      continue;
    }
    if (input[i] === "{") depth++;
    else if (input[i] === "}" && --depth === 0) {
      return { content: input.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

function skipAsciiWhitespace(input: string, from: number): number {
  let i = from;
  while (i < input.length && /[ \t\r\n]/.test(input[i])) i++;
  return i;
}

const BLACKBOARD_BOLD: Record<string, string> = {
  C: "ℂ",
  H: "ℍ",
  N: "ℕ",
  P: "ℙ",
  Q: "ℚ",
  R: "ℝ",
  Z: "ℤ",
};

const COMBINING_ACCENTS: Record<string, string> = {
  bar: "\u0304",
  overline: "\u0305",
  underline: "\u0332",
  hat: "\u0302",
  widehat: "\u0302",
  tilde: "\u0303",
  widetilde: "\u0303",
  dot: "\u0307",
  ddot: "\u0308",
  vec: "\u20D7",
};

function applyCombiningMark(content: string, mark: string): string {
  // Keep TeX commands intact for the main converter (for example
  // `\vec{\alpha}` must remain `\alpha` followed by the vector mark).
  if (content.includes("\\") || /[^\p{L}\p{N}]/u.test(content)) return `${content}${mark}`;
  return Array.from(content).map(char => `${char}${mark}`).join("");
}

/** Handle a few structural commands before the lightweight Unicode converter. */
function preprocessGroupedCommands(input: string, depth = 0): string {
  if (depth > 32 || input.indexOf("\\") < 0) return input;

  let out = "";
  let i = 0;
  while (i < input.length) {
    if (input[i] !== "\\") {
      out += input[i++];
      continue;
    }

    const commandMatch = input.slice(i).match(/^\\([A-Za-z]+)/);
    if (!commandMatch) {
      out += input[i++];
      continue;
    }

    const command = commandMatch[1];
    let argStart = skipAsciiWhitespace(input, i + commandMatch[0].length);

    // Indexed roots are not handled by the dependency's one-argument \sqrt.
    if (command === "sqrt" && input[argStart] === "[") {
      const indexEnd = input.indexOf("]", argStart + 1);
      if (indexEnd >= 0) {
        const radicandStart = skipAsciiWhitespace(input, indexEnd + 1);
        const radicand = readBraceGroup(input, radicandStart);
        if (radicand) {
          const index = preprocessGroupedCommands(input.slice(argStart + 1, indexEnd), depth + 1);
          const body = preprocessGroupedCommands(radicand.content, depth + 1);
          out += `root(${index}, ${body})`;
          i = radicand.end;
          continue;
        }
      }
    }

    // Binomial coefficients have two required grouped arguments.
    if (command === "binom") {
      const top = readBraceGroup(input, argStart);
      if (top) {
        const bottomStart = skipAsciiWhitespace(input, top.end);
        const bottom = readBraceGroup(input, bottomStart);
        if (bottom) {
          out += `C(${preprocessGroupedCommands(top.content, depth + 1)}, ${preprocessGroupedCommands(bottom.content, depth + 1)})`;
          i = bottom.end;
          continue;
        }
      }
    }

    const group = readBraceGroup(input, argStart);
    if (!group) {
      out += commandMatch[0];
      i += commandMatch[0].length;
      continue;
    }

    const content = preprocessGroupedCommands(group.content, depth + 1);
    if (command === "mathbb") {
      out += BLACKBOARD_BOLD[content.trim()] ?? content;
    } else if (command in COMBINING_ACCENTS) {
      out += applyCombiningMark(content, COMBINING_ACCENTS[command]);
    } else if (command === "abs") {
      out += `|${content}|`;
    } else if (command === "norm") {
      out += `‖${content}‖`;
    } else if (command === "boxed") {
      out += `[${content}]`;
    } else if (command === "pmod") {
      out += `(mod ${content})`;
    } else {
      // Let latex-to-unicode handle known wrappers, fractions, and roots.
      out += `${commandMatch[0]}{${content}}`;
    }
    i = group.end;
  }
  return out;
}

type MatrixEnvironment = "matrix" | "pmatrix" | "bmatrix" | "Bmatrix" | "vmatrix" | "Vmatrix" | "cases";

/** Split only at this environment's separators, not nested groups/environments. */
function splitEnvironmentBody(input: string, separator: "&" | "\\\\"): string[] {
  const parts: string[] = [];
  let start = 0;
  let braces = 0;
  let environments = 0;
  for (let i = 0; i < input.length;) {
    const environment = input.slice(i).match(/^\\(begin|end)\{[^}]+\}/);
    if (environment) {
      environments += environment[1] === "begin" ? 1 : -1;
      i += environment[0].length;
      continue;
    }
    if (braces === 0 && environments === 0 && input.startsWith(separator, i)) {
      parts.push(input.slice(start, i));
      i += separator.length;
      if (separator === "\\\\") {
        const spacing = input.slice(i).match(/^\[[^\]]*\]/);
        if (spacing) i += spacing[0].length;
      }
      start = i;
      continue;
    }
    if (input[i] === "\\") {
      const command = input.slice(i).match(/^\\(?:[A-Za-z]+|.)/);
      i += command?.[0].length ?? 1;
      continue;
    }
    if (input[i] === "{") braces++;
    else if (input[i] === "}") braces--;
    i++;
  }
  parts.push(input.slice(start));
  return parts;
}

function matrixDelimiters(environment: MatrixEnvironment, row: number, rows: number): [string, string] {
  const position = rows === 1 ? "only" : row === 0 ? "top" : row === rows - 1 ? "bottom" : "middle";
  switch (environment) {
    case "pmatrix":
      return position === "only" ? ["(", ")"]
        : position === "top" ? ["⎛", "⎞"]
        : position === "bottom" ? ["⎝", "⎠"] : ["⎜", "⎟"];
    case "bmatrix":
      return position === "only" ? ["[", "]"]
        : position === "top" ? ["⎡", "⎤"]
        : position === "bottom" ? ["⎣", "⎦"] : ["⎢", "⎥"];
    case "Bmatrix":
      return position === "only" ? ["{", "}"]
        : position === "top" ? ["⎧", "⎫"]
        : position === "bottom" ? ["⎩", "⎭"] : ["⎨", "⎬"];
    case "vmatrix": return ["│", "│"];
    case "Vmatrix": return ["‖", "‖"];
    case "cases":
      return [position === "only" ? "{" : position === "top" ? "⎧" : position === "bottom" ? "⎩" : "⎨", ""];
    case "matrix": return ["", ""];
  }
}

function renderMatrix(environment: MatrixEnvironment, body: string, display: boolean, depth: number): string {
  const rows = splitEnvironmentBody(body, "\\\\")
    .map(row => splitEnvironmentBody(row, "&")
      .map(cell => convertLatexMathInternal(cell.trim(), false, depth + 1)).join(" ").trim())
    .filter((row, index, all) => row !== "" || all.length === 1 || index < all.length - 1);

  if (!display) {
    const open = environment === "pmatrix" ? "(" : environment === "bmatrix" ? "["
      : environment === "Bmatrix" || environment === "cases" ? "{"
      : environment === "vmatrix" ? "|" : environment === "Vmatrix" ? "‖" : "[";
    const close = environment === "pmatrix" ? ")" : environment === "bmatrix" ? "]"
      : environment === "Bmatrix" || environment === "cases" ? "}"
      : environment === "vmatrix" ? "|" : environment === "Vmatrix" ? "‖" : "]";
    return `${open}${rows.join("; ")}${close}`;
  }

  return rows.map((row, index) => {
    const [left, right] = matrixDelimiters(environment, index, rows.length);
    return `${left} ${row} ${right}`.trimEnd();
  }).join("\n");
}

function readEnvironment(input: string, start: number): (GroupMatch & { environment: string }) | null {
  const opening = input.slice(start).match(/^\\begin\{(matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|cases|aligned|align\*?)\}/);
  if (!opening) return null;
  const bodyStart = start + opening[0].length;
  const boundaries = /\\(begin|end)\{([^}]+)\}/g;
  boundaries.lastIndex = bodyStart;
  const stack = [opening[1]];
  for (let boundary; (boundary = boundaries.exec(input));) {
    if (isEscaped(input, boundary.index)) continue;
    if (boundary[1] === "begin") {
      stack.push(boundary[2]);
    } else {
      if (stack.pop() !== boundary[2]) return null;
      if (stack.length === 0) {
        return { environment: opening[1], content: input.slice(bodyStart, boundary.index), end: boundaries.lastIndex };
      }
    }
  }
  return null;
}

function renderEnvironment(environment: string, body: string, display: boolean, depth: number): string {
  if (environment === "aligned" || environment.startsWith("align")) {
    const rows = splitEnvironmentBody(body, "\\\\")
      .map(row => convertLatexMathInternal(splitEnvironmentBody(row, "&").join("").trim(), display, depth + 1));
    return display ? rows.join("\n") : rows.join("; ");
  }
  return renderMatrix(environment as MatrixEnvironment, body, display, depth);
}

function readScriptArgument(input: string, from: number): GroupMatch | null {
  const start = skipAsciiWhitespace(input, from);
  if (start >= input.length) return null;
  if (input[start] === "{") return readBraceGroup(input, start);
  if (input[start] === "\\") {
    const command = input.slice(start).match(/^\\(?:[A-Za-z]+|.)/);
    if (!command) return null;
    let end = start + command[0].length;
    if (command[0] === "\\sqrt" && input[end] === "[") {
      const indexEnd = input.indexOf("]", end + 1);
      if (indexEnd >= 0) end = indexEnd + 1;
    }
    // Keep common macro invocations together when they are bare script arguments.
    const argumentsCount = /^\\(?:[td]?frac|binom)$/.test(command[0]) ? 2
      : /^\\(?:text|mathrm|mathbf|boldsymbol|operatorname|sqrt|mathbb|mathcal|mathscr|mathfrak|mathsf|mathtt|abs|norm|boxed|bar|overline|underline|hat|widehat|tilde|widetilde|dot|ddot|vec)$/.test(command[0]) ? 1 : 0;
    for (let arg = 0; arg < argumentsCount; arg++) {
      const group = readBraceGroup(input, skipAsciiWhitespace(input, end));
      if (!group) break;
      end = group.end;
    }
    return { content: input.slice(start, end), end };
  }
  const content = String.fromCodePoint(input.codePointAt(start)!);
  return { content, end: start + content.length };
}

/** Protect complete structures before the dependency strips grouping and spacing. */
function preprocessStructures(input: string, display: boolean, depth: number, protect: (text: string) => string): string {
  let out = "";
  let boundOperator = false;
  for (let i = 0; i < input.length;) {
    if (input[i] === "\\") {
      const environment = readEnvironment(input, i);
      if (environment) {
        out += protect(renderEnvironment(environment.environment, environment.content, display, depth));
        boundOperator = false;
        i = environment.end;
        continue;
      }
      const command = input.slice(i).match(/^\\(?:[A-Za-z]+|.)/);
      if (command) {
        if (!/^\\(?:no)?limits$/.test(command[0])) {
          boundOperator = /^\\(?:lim|limsup|liminf|min|max|sup|inf|argmin|argmax|sum|prod|int)$/.test(command[0]);
          out += command[0] === "\\_" ? protect("_") : command[0];
        }
        i += command[0].length;
        continue;
      }
    }
    const marker = input[i];
    if (marker === "_" || marker === "^") {
      const argument = readScriptArgument(input, i + 1);
      if (argument) {
        const content = convertLatexMathInternal(argument.content, false, depth + 1);
        const unicode = latexToUnicode(`${marker}{${content}}`, { latexCheck: false, fallbackBehaviour: "raw" });
        // All-or-nothing Unicode scripts avoid mixing baseline and raised text.
        // Unsupported compound scripts need visible grouping: e^(f(x)), not e^f(x).
        const script = unicode.startsWith(marker)
          ? `${marker}${Array.from(content).length === 1 ? content : `(${content})`}`
          : unicode;
        out += protect(script);
        i = argument.end;
        if (boundOperator && !/[_^]/.test(input[skipAsciiWhitespace(input, i)] ?? "")) {
          out += " ";
          boundOperator = false;
        }
        continue;
      }
      // Leave malformed/incomplete scripts readable instead of losing braces.
      out += protect(input.slice(i));
      break;
    }
    if (!/[ \t\r\n]/.test(marker)) boundOperator = false;
    out += input[i++];
  }
  return out;
}

/** Place multiline fragments side by side, rather than splicing their rows. */
function restoreFragments(input: string, fragments: string[], display: boolean): string {
  if (!display || fragments.length === 0) {
    return input.replace(/\uE003(\d+)\uE004/g, (whole, index: string) => fragments[Number(index)] ?? whole);
  }
  const lines = [""];
  const append = (text: string) => {
    const column = Math.max(...lines.map(termWidth));
    for (const [row, part] of text.split("\n").entries()) {
      const prefix = lines[row] ?? "";
      lines[row] = prefix + " ".repeat(column - termWidth(prefix)) + part;
    }
  };
  let start = 0;
  for (const match of input.matchAll(/\uE003(\d+)\uE004/g)) {
    append(input.slice(start, match.index));
    append(fragments[Number(match[1])] ?? match[0]);
    start = match.index + match[0].length;
  }
  append(input.slice(start));
  return lines.map(line => line.trimEnd()).join("\n");
}

export function convertLatexMath(source: string, display = false): string {
  return convertLatexMathInternal(source, display, 0);
}

function convertLatexMathInternal(source: string, display: boolean, depth: number): string {
  if (!source) return "";
  if (depth > 32) return source.trim();
  try {
    const fragments: string[] = [];
    const protect = (text: string) => `${FRAGMENT_START}${fragments.push(text) - 1}${FRAGMENT_END}`;
    // TeX treats physical newlines in ordinary display expressions as
    // whitespace. Collapse them before environment handling so pretty-printed
    // source does not turn every parenthesis/operator into its own terminal
    // row. Matrix/aligned/cases environments reintroduce intentional rows from
    // their `\\` separators below.
    const normalizedSource = display ? source.replace(/\s*\n\s*/g, " ") : source;
    let prepared = preprocessStructures(normalizedSource, display, depth, protect);
    prepared = preprocessGroupedCommands(prepared);
    prepared = prepared
      .replace(/\\(qquad|quad)\b/g, (_whole, command: string) => protect(command === "qquad" ? "    " : "  "))
      .replace(/\\\{/g, ESCAPED_LEFT_BRACE)
      .replace(/\\\}/g, ESCAPED_RIGHT_BRACE)
      .replace(/\\&/g, ESCAPED_AMPERSAND)
      .replace(/\\%/g, "%")
      .replace(/\\ /g, " ")
      .replace(/\\not\s*=/g, " ≠ ");

    const converted = latexToUnicode(prepared, {
      latexCheck: false,
      customMacros: CUSTOM_MACROS,
      // Complete scripts have already been protected above. Keep any remaining
      // unsupported/malformed syntax raw rather than mixing baseline glyphs
      // with super/subscript parentheses.
      fallbackBehaviour: "raw",
    })
      .replaceAll(ESCAPED_LEFT_BRACE, "{")
      .replaceAll(ESCAPED_RIGHT_BRACE, "}")
      .replaceAll(ESCAPED_AMPERSAND, "&")
      .replace(/\*/g, "×")
      .replace(/[ \t]+([,.;:])/g, "$1")
      .replace(/\([ \t]+/g, "(")
      .replace(/[ \t]+\)/g, ")")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
    return restoreFragments(converted, fragments, display);
  } catch {
    // Rendering is presentation-only. A malformed expression must never make a
    // conversation disappear or crash the TUI.
    return source.trim();
  }
}

function isEscaped(input: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && input[i] === "\\"; i--) backslashes++;
  return backslashes % 2 === 1;
}

function findUnescapedToken(input: string, token: string, from: number): number {
  let index = input.indexOf(token, from);
  while (index >= 0) {
    if (!isEscaped(input, index)) return index;
    index = input.indexOf(token, index + token.length);
  }
  return -1;
}

function countRun(input: string, from: number, char: string): number {
  let i = from;
  while (input[i] === char) i++;
  return i - from;
}

function findCodeSpanClose(input: string, from: number, ticks: number): number {
  let i = from;
  while (i < input.length) {
    if (input[i] !== "`") {
      i++;
      continue;
    }
    const run = countRun(input, i, "`");
    if (run === ticks) return i;
    i += run;
  }
  return -1;
}

function likelyDollarMath(content: string, lineBoundary: string): boolean {
  if (!content || /^\s|\s$/.test(content) || content.includes("\n") || content.includes(lineBoundary)) return false;
  // Avoid pairing two currency amounts in prose, such as "$5 and $10".
  if (/^\d[\d,.]*$/.test(content) || (/^\d/.test(content) && /,/.test(content))) return false;
  if (/^[A-Za-z]+(?:\s+[A-Za-z0-9]+)+$/.test(content)) return false;
  return /[A-Za-z0-9α-ωΑ-Ω\\_^=+*/<>()[\]{}|−∞∑∫]/u.test(content);
}

function findDollarClose(input: string, from: number, double: boolean): number {
  const token = double ? "$$" : "$";
  let i = from;
  while (i < input.length) {
    const found = input.indexOf(token, i);
    if (found < 0) return -1;
    if (!isEscaped(input, found) && (double || (input[found - 1] !== "$" && input[found + 1] !== "$"))) {
      return found;
    }
    i = found + token.length;
  }
  return -1;
}

/** Convert inline math while leaving Markdown code spans and ordinary currency alone. */
export function renderInlineMath(input: string): string {
  return renderInlineMathWithBoundary(input, "\n");
}

function renderInlineMathWithBoundary(input: string, lineBoundary: string): string {
  if (!input || (input.indexOf("\\(") < 0 && input.indexOf("\\[") < 0 && input.indexOf("$") < 0)) {
    return input;
  }

  let out = "";
  let i = 0;
  while (i < input.length) {
    if (input[i] === "`") {
      const ticks = countRun(input, i, "`");
      const close = findCodeSpanClose(input, i + ticks, ticks);
      if (close >= 0) {
        const end = close + ticks;
        out += input.slice(i, end);
        i = end;
        continue;
      }
    }

    const slashToken = input.startsWith("\\(", i) ? ["\\(", "\\)"] as const
      : input.startsWith("\\[", i) ? ["\\[", "\\]"] as const : null;
    if (slashToken && !isEscaped(input, i)) {
      const close = findUnescapedToken(input, slashToken[1], i + 2);
      if (close >= 0) {
        out += convertLatexMath(input.slice(i + 2, close));
        i = close + 2;
        continue;
      }
    }

    if (input[i] === "$" && !isEscaped(input, i)) {
      const double = input[i + 1] === "$";
      const delimiterLength = double ? 2 : 1;
      const close = findDollarClose(input, i + delimiterLength, double);
      if (close >= 0) {
        const content = input.slice(i + delimiterLength, close);
        // A dollar followed by a digit starts another price, not a closing
        // delimiter: **$100k** and **$60k** must stay Markdown, not TeX.
        if (double || (!/[0-9]/.test(input[close + 1] ?? "") && likelyDollarMath(content, lineBoundary))) {
          out += convertLatexMath(content);
          i = close + delimiterLength;
          continue;
        }
      }
    }

    out += input[i++];
  }
  return out;
}

/**
 * Render a paragraph while preserving code spans that cross hard newlines.
 * Private-use separators keep physical line boundaries stable while the inline
 * scanner sees one joined Markdown context.
 */
export function renderInlineMathChunks(lines: string[]): string[] {
  if (lines.length <= 1) return lines.map(renderInlineMath);

  let codePoint = 0xE100;
  let separator = String.fromCodePoint(codePoint);
  const combined = lines.join("\n");
  while (combined.includes(separator) && codePoint < 0xF8FF) {
    separator = String.fromCodePoint(++codePoint);
  }
  if (combined.includes(separator)) {
    // Extremely unlikely private-use exhaustion: correctness is safer than
    // converting notation inside a potentially multiline code span.
    return lines;
  }

  return renderInlineMathWithBoundary(lines.join(separator), separator).split(separator);
}

export interface DisplayMathBlock {
  source: string;
  nextLine: number;
}

/** Read a standalone `\[ ... \]` or `$$ ... $$` block from physical lines. */
export function takeDisplayMathBlock(lines: string[], start: number): DisplayMathBlock | null {
  const line = lines[start] ?? "";
  const leading = line.match(/^\s*/)?.[0].length ?? 0;
  const opener = line.startsWith("\\[", leading) ? "\\["
    : line.startsWith("$$", leading) && line[leading + 2] !== "$" ? "$$" : null;
  if (!opener) return null;
  const closer = opener === "\\[" ? "\\]" : "$$";

  const chunks: string[] = [];
  let current = line.slice(leading + opener.length);
  for (let index = start; index < lines.length; index++) {
    if (index > start) current = lines[index];
    const close = findUnescapedToken(current, closer, 0);
    if (close >= 0) {
      // A block parser cannot safely consume prose following the closing token.
      // Same-line forms with prose are still handled by renderInlineMath.
      if (current.slice(close + closer.length).trim() !== "") return null;
      chunks.push(current.slice(0, close));
      return { source: chunks.join("\n"), nextLine: index + 1 };
    }
    chunks.push(current);
  }
  return null;
}

export interface LocatedDisplayMathBlock extends DisplayMathBlock {
  startLine: number;
}

/**
 * Find complete display blocks in a paragraph without treating multiline code
 * spans as math. Code-span lookahead is limited to the paragraph's inline
 * context; a display block itself may extend past `end` through blank lines.
 */
export function findDisplayMathBlocks(lines: string[], start: number, end: number): LocatedDisplayMathBlock[] {
  let hasMath = false;
  for (let index = start; index < end; index++) {
    if (/^\s*(?:\\\[|\$\$)/.test(lines[index])) {
      hasMath = true;
      break;
    }
  }
  if (!hasMath) return [];

  const source = lines.slice(start, end).join("\n");
  const blocks: LocatedDisplayMathBlock[] = [];
  let offset = 0;
  let codeEnd = 0;
  let index = start;
  while (index < end) {
    const block = offset >= codeEnd ? takeDisplayMathBlock(lines, index) : null;
    if (block) {
      blocks.push({ startLine: index, ...block });
      // Do not interpret backticks in TeX as Markdown code delimiters.
      while (index < block.nextLine) offset += lines[index++].length + 1;
      continue;
    }

    const lineEnd = offset + lines[index].length;
    let cursor = Math.max(offset, codeEnd);
    while (cursor < lineEnd) {
      const tick = source.indexOf("`", cursor);
      if (tick < 0 || tick >= lineEnd) break;
      const ticks = countRun(source, tick, "`");
      const close = findCodeSpanClose(source, tick + ticks, ticks);
      if (close >= 0) {
        codeEnd = close + ticks;
        cursor = codeEnd;
      } else {
        // Unmatched backticks are literal text, not an open code span.
        cursor = tick + ticks;
      }
    }
    offset = lineEnd + 1;
    index++;
  }
  return blocks;
}

export interface RenderedDisplayMath {
  lines: string[];
  cont: boolean[];
  join: string[];
  copy: Array<WrapCopyLine | null>;
}

function breakMathLine(line: string, width: number): string[] {
  if (line === "" || termWidth(line) <= width) return [line];
  const chunks: string[] = [];
  let rest = line;
  while (rest) {
    let [chunk, tail] = sliceByWidth(rest, width);
    if (!chunk) {
      chunk = rest[0];
      tail = rest.slice(1);
    }
    chunks.push(chunk);
    rest = tail;
  }
  return chunks;
}

/** Render a display expression as ordinary left-aligned assistant text. */
export function renderDisplayMath(source: string, width: number): RenderedDisplayMath {
  const safeWidth = Math.max(1, width);
  const converted = convertLatexMath(source, true);
  const lines: string[] = [];
  const cont: boolean[] = [];
  const join: string[] = [];
  const copy: Array<WrapCopyLine | null> = [];

  for (const logicalLine of converted.split("\n")) {
    const chunks = breakMathLine(logicalLine, safeWidth);
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      lines.push(chunk);
      cont.push(index > 0);
      join.push("");
      copy.push({ text: chunk, displayStart: 0 });
    }
  }

  return { lines, cont, join, copy };
}
