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
    if (input[i] === "{") depth++;
    else if (input[i] === "}" && --depth === 0) {
      return { content: input.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

function skipAsciiWhitespace(input: string, from: number): number {
  let i = from;
  while (i < input.length && (input[i] === " " || input[i] === "\t")) i++;
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

function renderMatrix(environment: MatrixEnvironment, body: string, display: boolean): string {
  const rows = body
    .split(/\\\\(?:\[[^\]]*\])?/)
    .map(row => row.split("&").map(cell => cell.trim()).join("  ").trim())
    .filter((row, index, all) => row !== "" || all.length === 1 || index < all.length - 1);

  if (!display) {
    const open = environment === "pmatrix" ? "(" : environment === "bmatrix" ? "["
      : environment === "Bmatrix" || environment === "cases" ? "{"
      : environment === "vmatrix" ? "|" : environment === "Vmatrix" ? "‖" : "[";
    const close = environment === "pmatrix" ? ")" : environment === "bmatrix" ? "]"
      : environment === "Bmatrix" ? "}" : environment === "cases" ? ""
      : environment === "vmatrix" ? "|" : environment === "Vmatrix" ? "‖" : "]";
    return `${open}${rows.join("; ")}${close}`;
  }

  return rows.map((row, index) => {
    const [left, right] = matrixDelimiters(environment, index, rows.length);
    return `${left} ${row} ${right}`.trimEnd();
  }).join("\n");
}

function preprocessEnvironments(input: string, display: boolean): string {
  return input.replace(
    /\\begin\{(matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|cases|aligned|align\*?)\}([\s\S]*?)\\end\{\1\}/g,
    (_whole, rawEnvironment: string, body: string) => {
      if (rawEnvironment === "aligned" || rawEnvironment.startsWith("align")) {
        const rows = body.split(/\\\\(?:\[[^\]]*\])?/).map(row => row.replace(/&/g, "").trim());
        return display ? rows.join("\n") : rows.join("; ");
      }
      return renderMatrix(rawEnvironment as MatrixEnvironment, body, display);
    },
  );
}

export function convertLatexMath(source: string, display = false): string {
  if (!source) return "";
  try {
    let prepared = preprocessEnvironments(source, display);
    prepared = preprocessGroupedCommands(prepared);
    prepared = prepared
      .replace(/\\\{/g, ESCAPED_LEFT_BRACE)
      .replace(/\\\}/g, ESCAPED_RIGHT_BRACE)
      .replace(/\\&/g, ESCAPED_AMPERSAND)
      .replace(/\\%/g, "%")
      .replace(/\\ /g, " ")
      .replace(/\\not\s*=/g, " ≠ ");

    return latexToUnicode(prepared, {
      latexCheck: false,
      customMacros: CUSTOM_MACROS,
      fallbackBehaviour: "parentheses",
    })
      .replaceAll(ESCAPED_LEFT_BRACE, "{")
      .replaceAll(ESCAPED_RIGHT_BRACE, "}")
      .replaceAll(ESCAPED_AMPERSAND, "&")
      .replace(/\*/g, "×")
      .replace(/[ \t]+([,.;:])/g, "$1")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
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

function likelyDollarMath(content: string): boolean {
  if (!content || /^\s|\s$/.test(content) || content.includes("\n")) return false;
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
        if (double || likelyDollarMath(content)) {
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

  return renderInlineMath(lines.join(separator)).split(separator);
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
