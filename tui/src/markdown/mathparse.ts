import {
  ACCENTS,
  DROPPED_WITH_ARGUMENT,
  FONT_COMMANDS,
  FUNCTION_NAMES,
  IGNORED_COMMANDS,
  LARGE_OPERATORS,
  LIMIT_OPERATORS,
  NEGATED,
  OPERATOR_DISPLAY_NAMES,
  SPACES,
  SPANNING_ACCENTS,
  SYMBOLS,
  TEXT_COMMANDS,
  applyFont,
  charClass,
  type AtomClass,
  type FontStyle,
} from "./mathsymbols";

/**
 * A forgiving TeX math parser for terminal rendering.
 *
 * It accepts the subset of TeX that chat models emit, including TeX's
 * brace-less arguments (`\frac12`, `\sqrt2`, `x^2`), and never throws: missing
 * arguments become empty, stray braces are skipped, and unknown commands keep
 * their name (without the backslash) so following arguments stay readable.
 */

export type MathNode =
  | { type: "atom"; text: string; cls: AtomClass }
  | { type: "text"; text: string }
  | { type: "space"; width: number }
  | { type: "group"; body: MathNode[] }
  | { type: "scripts"; base: MathNode | null; sup: MathNode[] | null; sub: MathNode[] | null; limits?: boolean }
  | { type: "frac"; num: MathNode[]; den: MathNode[] }
  | { type: "binom"; top: MathNode[]; bottom: MathNode[] }
  | { type: "sqrt"; index: MathNode[] | null; body: MathNode[] }
  | { type: "op"; text: string; limits: boolean; large: boolean }
  | { type: "delim"; left: string; right: string; body: MathNode[] }
  | { type: "accent"; mark: string; spanning: boolean; body: MathNode[] }
  | { type: "boxed"; body: MathNode[] }
  | { type: "env"; name: string; rows: MathNode[][][]; columns: string | null }
  | { type: "newline" }
  | { type: "tag"; body: MathNode[] }
  | { type: "pmod"; body: MathNode[]; word: boolean };

/** Infix commands (`{n \choose k}`, `{a \over b}`) resolved within their group. */
type Infix = { type: "infix"; name: "over" | "choose" | "atop" | "brack" | "brace" };
type ParsedNode = MathNode | Infix;

const MAX_DEPTH = 60;

const ROW_ENVIRONMENTS = /^(?:aligned|align\*?|alignat\*?|alignedat|flalign\*?|eqnarray\*?|gather\*?|gathered|equation\*?|split|multline\*?|subequations|displaymath|math)$/;

export function isRowEnvironment(name: string): boolean {
  return ROW_ENVIRONMENTS.test(name);
}

/** Environments that can stand alone as display math without `$$` or `\[`. */
export const BARE_MATH_ENVIRONMENTS = /^(?:equation\*?|align\*?|alignat\*?|aligned|alignedat|flalign\*?|eqnarray\*?|gather\*?|gathered|multline\*?|split|cases|dcases|rcases|matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|smallmatrix|array|displaymath|math)$/;

class Parser {
  private i = 0;
  private depth = 0;

  constructor(private readonly src: string) {}

  parseAll(): MathNode[] {
    const out: MathNode[] = [];
    while (this.i < this.src.length) {
      out.push(...this.parseList(() => false));
      // A stray closer stopped the list: skip it and continue.
      if (this.i < this.src.length) this.i++;
    }
    return out;
  }

  private at(text: string): boolean {
    return this.src.startsWith(text, this.i);
  }

  private letterRunAt(index: number): number {
    let end = index;
    while (end < this.src.length && /\p{L}/u.test(this.src[end])) end++;
    return end - index;
  }

  private skipSpace(): void {
    while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i++;
  }

  /** `\name` (letters, optionally `*`) at the cursor, without consuming it. */
  private peekCommand(): string | null {
    if (this.src[this.i] !== "\\") return null;
    const match = /^\\([A-Za-z]+\*?|.)/s.exec(this.src.slice(this.i, this.i + 40));
    return match ? match[1] : null;
  }

  private atCommand(name: string): boolean {
    return this.at(`\\${name}`) && !/[A-Za-z]/.test(this.src[this.i + name.length + 1] ?? "");
  }

  private atEnvironmentEnd(): boolean {
    return this.atCommand("end");
  }

  /**
   * Parse items until `stop` says so (or the input ends, or an unmatched `}`
   * appears). Scripts and primes attach to the preceding item.
   */
  private parseList(stop: () => boolean, inGroup = false): MathNode[] {
    if (++this.depth > MAX_DEPTH) {
      // Pathological nesting: keep the remaining source readable as text.
      const rest = this.src.slice(this.i);
      this.i = this.src.length;
      this.depth--;
      return [{ type: "text", text: rest }];
    }
    const items: ParsedNode[] = [];
    // Consecutive plain letters just parsed, to recognise prose inside math.
    let letterRun = 0;
    for (;;) {
      const before = this.i;
      this.skipSpace();
      const sawSpace = this.i > before;
      if (this.i >= this.src.length || stop()) break;
      const char = this.src[this.i];
      // Models sometimes write prose in math mode ("\approx 4 hours for one
      // PushT-scale run"). TeX would run the words together; keep the
      // spaces between words and hyphens inside them.
      const last = items[items.length - 1];
      const afterWordish = letterRun > 0 || (last?.type === "atom" && /^\d$/.test(last.text));
      if (afterWordish && sawSpace && /\p{L}/u.test(char) && (letterRun >= 2 || this.letterRunAt(this.i) >= 2)) {
        items.push({ type: "space", width: 1 });
      }
      if (char === "-" && !sawSpace && letterRun >= 2 && this.letterRunAt(this.i + 1) >= 2) {
        items.push({ type: "atom", text: "-", cls: "ord" });
        this.i++;
        letterRun = 0;
        continue;
      }
      if (char === "}") {
        if (inGroup) break;
        this.i++;
        continue;
      }
      if (char === "^" || char === "_") {
        this.attachScript(items);
        letterRun = 0;
        continue;
      }
      if (char === "'") {
        let count = 0;
        while (this.src[this.i] === "'") {
          count++;
          this.i++;
        }
        const primes = count === 1 ? "′" : count === 2 ? "″" : count === 3 ? "‴" : "′".repeat(count);
        items.push({ type: "atom", text: primes, cls: "ord" });
        letterRun = 0;
        continue;
      }
      const command = this.peekCommand();
      if (command === "limits" || command === "nolimits") {
        this.i += command.length + 1;
        const previous = items[items.length - 1];
        if (previous?.type === "op") previous.limits = command === "limits";
        else if (previous?.type === "scripts") previous.limits = command === "limits";
        continue;
      }
      const node = this.parseItem();
      if (node) items.push(node);
      letterRun = char !== "\\" && node?.type === "atom" && /^\p{L}$/u.test(node.text) ? letterRun + 1 : 0;
    }
    this.depth--;
    return resolveInfix(items);
  }

  private attachScript(items: ParsedNode[]): void {
    const marker = this.src[this.i++];
    const argument = this.readArgument();
    const last = items[items.length - 1];
    const previous: MathNode | undefined = last?.type === "infix" ? undefined : last;
    let target: Extract<MathNode, { type: "scripts" }>;
    if (previous?.type === "scripts" && (marker === "^" ? previous.sup === null : previous.sub === null)) {
      target = previous;
    } else if (previous && previous.type !== "space") {
      items.pop();
      target = { type: "scripts", base: previous, sup: null, sub: null };
      if (previous.type === "op") target.limits = previous.limits;
      items.push(target);
    } else {
      target = { type: "scripts", base: null, sup: null, sub: null };
      items.push(target);
    }
    if (marker === "^") target.sup = [...(target.sup ?? []), ...argument];
    else target.sub = [...(target.sub ?? []), ...argument];
  }

  /** A TeX macro argument: a braced group, one command (with its own arguments), or one character. */
  private readArgument(): MathNode[] {
    this.skipSpace();
    if (this.i >= this.src.length) return [];
    const char = this.src[this.i];
    if (char === "{") {
      this.i++;
      const body = this.parseList(() => false, true);
      if (this.src[this.i] === "}") this.i++;
      return body;
    }
    if (char === "}" || char === "&" || char === "^" || char === "_") return [];
    if (char === "\\") {
      if (this.at("\\\\") || this.atEnvironmentEnd() || this.atCommand("right")) return [];
    }
    const node = this.parseItem();
    return node && node.type !== "infix" ? [node] : [];
  }

  /** Raw text of a braced group (or one character), for `\text` and names. */
  private readRawArgument(): string {
    this.skipSpace();
    if (this.src[this.i] !== "{") {
      if (this.i >= this.src.length) return "";
      const command = this.peekCommand();
      if (command) {
        this.i += command.length + 1;
        return `\\${command}`;
      }
      const char = String.fromCodePoint(this.src.codePointAt(this.i)!);
      this.i += char.length;
      return char;
    }
    let depth = 0;
    const start = this.i + 1;
    for (let j = this.i; j < this.src.length; j++) {
      const c = this.src[j];
      if (c === "\\") {
        j++;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        this.i = j + 1;
        return this.src.slice(start, j);
      }
    }
    this.i = this.src.length;
    return this.src.slice(start);
  }

  /** `[...]` optional argument, if present. */
  private readOptional(): string | null {
    this.skipSpace();
    if (this.src[this.i] !== "[") return null;
    let depth = 0;
    for (let j = this.i + 1; j < this.src.length; j++) {
      const c = this.src[j];
      if (c === "\\") {
        j++;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === "]" && depth <= 0) {
        const content = this.src.slice(this.i + 1, j);
        this.i = j + 1;
        return content;
      }
    }
    return null;
  }

  private parseItem(): ParsedNode | null {
    const char = this.src[this.i];
    if (char === "{") {
      this.i++;
      const body = this.parseList(() => false, true);
      if (this.src[this.i] === "}") this.i++;
      return { type: "group", body };
    }
    if (char === "\\") return this.parseCommand();
    if (char === "~") {
      this.i++;
      return { type: "space", width: 1 };
    }
    if (char === "&" || char === "$" || char === "#") {
      // Alignment marks outside an environment and stray dollars are layout
      // syntax, not content.
      this.i++;
      return char === "#" ? { type: "atom", text: "#", cls: "ord" } : null;
    }
    const text = String.fromCodePoint(this.src.codePointAt(this.i)!);
    this.i += text.length;
    if (text === "-") return { type: "atom", text: "−", cls: "bin" };
    return { type: "atom", text, cls: charClass(text) };
  }

  private parseCommand(): ParsedNode | null {
    if (this.at("\\\\")) {
      this.i += 2;
      if (this.src[this.i] === "*") this.i++;
      this.readOptional();
      return { type: "newline" };
    }
    const name = this.peekCommand();
    if (!name) {
      this.i++;
      return null;
    }
    this.i += name.length + 1;

    // Control symbols: \, \; \{ \} \| \$ ...
    if (!/^[A-Za-z]/.test(name)) {
      if (name in SPACES) return SPACES[name] > 0 ? { type: "space", width: SPACES[name] } : null;
      if (name === "{") return { type: "atom", text: "{", cls: "open" };
      if (name === "}") return { type: "atom", text: "}", cls: "close" };
      if (name === "|") return { type: "atom", text: "‖", cls: "ord" };
      if (name === "\n" || name === "\t" || name === " ") return { type: "space", width: 1 };
      return { type: "atom", text: name, cls: "ord" };
    }

    const bare = name.endsWith("*") ? name.slice(0, -1) : name;
    if (name === "begin") return this.parseEnvironment();
    if (name === "end") {
      this.readRawArgument();
      return null;
    }
    if (name === "left") return this.parseLeftRight();
    if (name === "right") {
      this.readDelimiter();
      return null;
    }
    if (name === "middle") {
      const delimiter = this.readDelimiter();
      return delimiter ? { type: "atom", text: delimiter, cls: "rel" } : null;
    }
    if (/^(?:big|Big|bigg|Bigg)[lrm]?$/.test(name)) {
      const delimiter = this.readDelimiter();
      if (!delimiter) return null;
      const side = name.at(-1);
      const cls: AtomClass = side === "l" ? "open" : side === "r" ? "close" : side === "m" ? "rel" : charClass(delimiter);
      return { type: "atom", text: delimiter, cls };
    }
    if (/^(?:frac|dfrac|tfrac|cfrac)$/.test(name)) {
      const num = this.readArgument();
      const den = this.readArgument();
      return { type: "frac", num, den };
    }
    if (/^(?:binom|dbinom|tbinom)$/.test(name)) {
      const top = this.readArgument();
      const bottom = this.readArgument();
      return { type: "binom", top, bottom };
    }
    if (name === "over" || name === "choose" || name === "atop" || name === "brack" || name === "brace") {
      return { type: "infix", name };
    }
    if (name === "sqrt") {
      const indexSource = this.readOptional();
      const index = indexSource === null ? null : parseMath(indexSource);
      return { type: "sqrt", index, body: this.readArgument() };
    }
    if (TEXT_COMMANDS.has(name)) return this.textNode(this.readRawArgument());
    if (name in FONT_COMMANDS) {
      // An upright word (\mathrm{net}) reads as text, not as a product of letters.
      const word = FONT_COMMANDS[name] === "plain" && /^\{\s*[A-Za-z]{2,}(?:[ -][A-Za-z]+)*\s*\}/.exec(this.src.slice(this.i).trimStart());
      if (word) return this.textNode(this.readRawArgument().trim());
      return { type: "group", body: withFont(this.readArgument(), FONT_COMMANDS[name]) };
    }
    if (bare === "operatorname") {
      const text = plainName(this.readRawArgument());
      return { type: "op", text, limits: name.endsWith("*"), large: false };
    }
    if (name in ACCENTS) {
      return { type: "accent", mark: ACCENTS[name], spanning: SPANNING_ACCENTS.has(name), body: this.readArgument() };
    }
    if (name === "overset" || name === "stackrel" || name === "underset") {
      const annotation = this.readArgument();
      const base = this.readArgument();
      const baseNode: MathNode = base.length === 1 ? base[0] : { type: "group", body: base };
      return name === "underset"
        ? { type: "scripts", base: baseNode, sup: null, sub: annotation, limits: true }
        : { type: "scripts", base: baseNode, sup: annotation, sub: null, limits: true };
    }
    if (name === "overbrace" || name === "underbrace" || name === "boldsymbol" || name === "smash") {
      return { type: "group", body: this.readArgument() };
    }
    if (name === "xrightarrow" || name === "xleftarrow" || name === "xRightarrow" || name === "xLeftarrow") {
      this.readOptional();
      const label = this.readArgument();
      const arrow = name === "xrightarrow" ? "→" : name === "xleftarrow" ? "←" : name === "xRightarrow" ? "⇒" : "⇐";
      return { type: "scripts", base: { type: "atom", text: arrow, cls: "rel" }, sup: label, sub: null, limits: true };
    }
    if (bare === "boxed" || bare === "fbox" || bare === "framebox") {
      if (bare === "framebox") this.readOptional();
      return { type: "boxed", body: this.readArgument() };
    }
    if (bare === "tag") return { type: "tag", body: this.textBody(this.readRawArgument()) };
    if (name === "pmod" || name === "pod") return { type: "pmod", body: this.readArgument(), word: name === "pmod" };
    if (name === "mod") return { type: "atom", text: "mod", cls: "bin" };
    if (name === "not") return this.parseNot();
    if (name === "substack") {
      const rows = this.environmentRows(this.readRawArgument());
      return { type: "env", name: "substack", rows, columns: null };
    }
    if (name === "textcolor" || name === "colorbox") {
      this.readRawArgument();
      return { type: "group", body: this.readArgument() };
    }
    if (name === "href") {
      this.readRawArgument();
      return this.textNode(this.readRawArgument());
    }
    if (name === "url") return this.textNode(this.readRawArgument());
    if (name === "eqref" || name === "ref") {
      const label = this.readRawArgument();
      return { type: "text", text: name === "eqref" ? `(${label})` : label };
    }
    if (name in DROPPED_WITH_ARGUMENT) {
      for (let k = 0; k < DROPPED_WITH_ARGUMENT[name]; k++) this.readRawArgument();
      return name.startsWith("hspace") ? { type: "space", width: 1 } : null;
    }
    if (IGNORED_COMMANDS.has(name)) return null;
    if (name in SPACES) return SPACES[name] > 0 ? { type: "space", width: SPACES[name] } : null;
    if (name in LARGE_OPERATORS) {
      const [text, limits] = LARGE_OPERATORS[name];
      return { type: "op", text, limits, large: true };
    }
    if (FUNCTION_NAMES.has(name)) {
      return { type: "op", text: OPERATOR_DISPLAY_NAMES[name] ?? name, limits: LIMIT_OPERATORS.has(name), large: false };
    }
    const symbol = SYMBOLS[name];
    if (symbol) return { type: "atom", text: symbol.text, cls: symbol.cls };
    // Unknown command: keep its name (not the backslash) as an upright
    // operator; any braced arguments that follow render as ordinary groups.
    return { type: "op", text: bare, limits: false, large: false };
  }

  private parseNot(): MathNode | null {
    this.skipSpace();
    const next = this.parseItem();
    if (!next || next.type === "infix") return null;
    if (next.type !== "atom") return next;
    const negated = NEGATED[next.text];
    if (negated) return { type: "atom", text: negated, cls: next.cls === "ord" ? "ord" : "rel" };
    return { type: "atom", text: `${next.text}̸`, cls: next.cls };
  }

  /** A delimiter after \left, \right, \big…: a character or a delimiter command. */
  private readDelimiter(): string | null {
    this.skipSpace();
    if (this.i >= this.src.length) return null;
    const command = this.peekCommand();
    if (command) {
      this.i += command.length + 1;
      if (command === ".") return "";
      if (command === "{" || command === "lbrace") return "{";
      if (command === "}" || command === "rbrace") return "}";
      if (command === "|" || command === "Vert" || command === "lVert" || command === "rVert") return "‖";
      if (command === "vert" || command === "lvert" || command === "rvert" || command === "mid") return "|";
      if (command === "backslash") return "\\";
      return SYMBOLS[command]?.text ?? "";
    }
    const char = String.fromCodePoint(this.src.codePointAt(this.i)!);
    this.i += char.length;
    return char === "." ? "" : char;
  }

  private parseLeftRight(): MathNode {
    const left = this.readDelimiter() ?? "";
    const body = this.parseList(() => this.atCommand("right"), true);
    let right = "";
    if (this.atCommand("right")) {
      this.i += "\\right".length;
      right = this.readDelimiter() ?? "";
    }
    return { type: "delim", left, right, body };
  }

  private parseEnvironment(): MathNode | null {
    const name = this.readRawArgument().trim();
    let columns: string | null = null;
    if (/^(?:array|subarray|alignat\*?|alignedat|matrix\*|pmatrix\*|bmatrix\*|Bmatrix\*|vmatrix\*|Vmatrix\*)$/.test(name)) {
      this.readOptional();
      if (name.startsWith("array") || name === "subarray" || name.startsWith("alignat") || name === "alignedat") {
        columns = this.readRawArgument();
      } else {
        columns = this.readOptional();
      }
    } else if (name === "aligned" || name === "gathered" || name === "split") {
      this.readOptional();
    }
    const rows: MathNode[][][] = [];
    let cells: MathNode[][] = [];
    for (;;) {
      const cell = this.parseList(() => this.at("&") || this.at("\\\\") || this.atEnvironmentEnd(), true);
      cells.push(cell);
      if (this.at("&")) {
        this.i++;
        continue;
      }
      if (this.at("\\\\")) {
        this.i += 2;
        if (this.src[this.i] === "*") this.i++;
        this.readOptional();
        rows.push(cells);
        cells = [];
        continue;
      }
      if (this.atEnvironmentEnd()) {
        this.i += 4;
        this.readRawArgument();
      } else if (this.src[this.i] === "}") {
        // Unbalanced brace inside an environment: stop here.
        this.i++;
      }
      break;
    }
    rows.push(cells);
    // A trailing `\\` leaves an empty final row.
    while (rows.length > 1 && rows[rows.length - 1].every(cell => cell.length === 0)) rows.pop();
    return { type: "env", name, rows, columns };
  }

  /** Rows of `\substack{a\\b}`-style content. */
  private environmentRows(source: string): MathNode[][][] {
    return splitRows(source).map(row => [parseMath(row)]);
  }

  private textNode(raw: string): MathNode {
    const body = this.textBody(raw);
    return body.length === 1 ? body[0] : { type: "group", body };
  }

  /** `\text{...}` content: literal text with embedded `$...$` math. */
  private textBody(raw: string): MathNode[] {
    const out: MathNode[] = [];
    let text = "";
    const flush = () => {
      if (text) out.push({ type: "text", text });
      text = "";
    };
    for (let j = 0; j < raw.length; j++) {
      const c = raw[j];
      if (c === "$") {
        const close = raw.indexOf("$", j + 1);
        if (close > j) {
          flush();
          out.push({ type: "group", body: parseMath(raw.slice(j + 1, close)) });
          j = close;
          continue;
        }
        continue;
      }
      if (c === "{" || c === "}") continue;
      if (c === "~") {
        text += " ";
        continue;
      }
      if (c === "\\") {
        const match = /^\\([A-Za-z]+|.)/s.exec(raw.slice(j));
        if (!match) continue;
        const command = match[1];
        j += match[0].length - 1;
        if (!/^[A-Za-z]/.test(command)) {
          text += command === "," || command === ";" || command === " " ? " " : command;
          continue;
        }
        // Nested text commands (\textbf{...}) keep their content.
        if (TEXT_COMMANDS.has(command) || command in FONT_COMMANDS) continue;
        if (IGNORED_COMMANDS.has(command)) continue;
        if (command === "quad" || command === "qquad") {
          text += command === "quad" ? "  " : "    ";
          continue;
        }
        text += SYMBOLS[command]?.text ?? command;
        continue;
      }
      text += c;
    }
    flush();
    return out;
  }
}

function resolveInfix(items: ParsedNode[]): MathNode[] {
  const index = items.findIndex(item => item.type === "infix");
  if (index < 0) return items as MathNode[];
  const infix = items[index] as Infix;
  const before = resolveInfix(items.slice(0, index));
  const after = resolveInfix(items.slice(index + 1));
  if (infix.name === "over") return [{ type: "frac", num: before, den: after }];
  if (infix.name === "choose") return [{ type: "binom", top: before, bottom: after }];
  // \atop and friends: a fraction without a bar is closest to a binomial.
  return [{ type: "binom", top: before, bottom: after }];
}

function withFont(nodes: MathNode[], font: FontStyle): MathNode[] {
  if (font === "plain") return nodes;
  return nodes.map(node => node.type === "atom" ? { ...node, text: applyFont(node.text, font) } : node);
}

function plainName(raw: string): string {
  return raw.replace(/\\(?:mathrm|text|textrm|mathit|mathbf)\b/g, "").replace(/\\([,;: ])/g, " ").replace(/[{}\\]/g, "").trim();
}

/** Split `a \\ b` at top-level row separators. */
function splitRows(source: string): string[] {
  const rows: string[] = [];
  let depth = 0;
  let start = 0;
  for (let j = 0; j < source.length; j++) {
    const c = source[j];
    if (c === "\\" && source[j + 1] === "\\" && depth === 0) {
      rows.push(source.slice(start, j));
      j++;
      start = j + 1;
      continue;
    }
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  rows.push(source.slice(start));
  return rows;
}

export function parseMath(source: string): MathNode[] {
  return new Parser(source).parseAll();
}
