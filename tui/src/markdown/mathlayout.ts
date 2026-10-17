import { sliceByWidth, termWidth } from "../textwidth";
import { isRowEnvironment, type MathNode } from "./mathparse";
import { ACCENT_NAMES, VULGAR_FRACTIONS, toSubscript, toSuperscript, type AtomClass } from "./mathsymbols";

/**
 * Terminal layout for parsed TeX (see mathparse.ts).
 *
 * Inline math is laid out on one line: Unicode scripts where every character
 * has a Unicode form (x², aᵢ), `^(...)`/`_(...)` otherwise, vulgar fractions
 * for simple digit pairs (½) and `a/b` with parentheses where precedence needs
 * them. Display math uses a small box model instead: stacked fractions,
 * stretchy delimiters, limits above and below large operators, and aligned
 * environment grids. A display expression wider than the terminal falls back
 * to the linear form, broken before relations and binary operators.
 */

export interface Box {
  rows: string[];
  /** Row holding the math axis/baseline used to align neighbours. */
  base: number;
  width: number;
}

type ItemKind = "atom" | "text" | "op" | "group" | "linfrac" | "vulgar" | "frac2d" | "delim" | "sqrt" | "env" | "scripted" | "space";

interface Item {
  box: Box;
  cls: AtomClass | "space";
  kind: ItemKind;
  /** Source glyph for single atoms. */
  text?: string;
  unary?: boolean;
  limits?: boolean;
  /** A single term: safe as a denominator or script base without parentheses. */
  simple: boolean;
  /** Juxtaposed factors only: safe as a numerator without parentheses. */
  product: boolean;
  /** Ends in an unparenthesised `_x`/`^x` that a following letter would extend. */
  openScript?: boolean;
}

interface Context {
  /** Stacked (multi-row) layout is allowed. */
  stacked: boolean;
  /** Inside a superscript/subscript: compact spacing, always linear. */
  script: boolean;
  /** Use no-break spaces so prose wrapping cannot split the expression. */
  nbsp?: boolean;
}

const NBSP = "\u00A0";

const LINEAR: Context = { stacked: false, script: false };
const SCRIPT: Context = { stacked: false, script: true };
const STACKED: Context = { stacked: true, script: false };

function makeBox(rows: string[], base = 0): Box {
  const width = rows.reduce((max, row) => Math.max(max, termWidth(row)), 0);
  return { rows: rows.map(row => row + " ".repeat(width - termWidth(row))), base, width };
}

const line = (text: string): Box => makeBox([text]);
const EMPTY: Box = { rows: [""], base: 0, width: 0 };

/** Concatenate boxes left to right on a shared baseline. */
function hcat(boxes: Box[], gaps: number[] = [], space = " "): Box {
  if (boxes.length === 0) return EMPTY;
  const above = Math.max(...boxes.map(box => box.base));
  const below = Math.max(...boxes.map(box => box.rows.length - box.base - 1));
  const rows = Array.from({ length: above + below + 1 }, () => "");
  let width = 0;
  boxes.forEach((box, index) => {
    const gap = space.repeat(gaps[index] ?? 0);
    const offset = above - box.base;
    for (let row = 0; row < rows.length; row++) {
      const local = row - offset;
      rows[row] += gap + (local >= 0 && local < box.rows.length ? box.rows[local] : " ".repeat(box.width));
    }
    width += gap.length + box.width;
  });
  return { rows, base: above, width };
}

function center(box: Box, width: number): string[] {
  const left = Math.floor((width - box.width) / 2);
  return box.rows.map(row => " ".repeat(left) + row + " ".repeat(width - box.width - left));
}

/** Stack boxes vertically, centred; `baseBox` selects whose baseline the result uses. */
function vstack(boxes: Box[], baseBox: number): Box {
  const width = Math.max(...boxes.map(box => box.width));
  const rows: string[] = [];
  let base = 0;
  boxes.forEach((box, index) => {
    if (index === baseBox) base = rows.length + box.base;
    rows.push(...center(box, width));
  });
  return { rows, base, width };
}

function item(box: Box, cls: Item["cls"], kind: ItemKind, simple: boolean, product: boolean, extra: Partial<Item> = {}): Item {
  return { box, cls, kind, simple, product, ...extra };
}

function boxText(box: Box): string {
  return box.rows[box.base] ?? "";
}

// ── Lists ──────────────────────────────────────────────────────────────

function renderList(nodes: MathNode[], ctx: Context): Item[] {
  const prepared = ctx.stacked && !ctx.script ? autoDelimiters(nodes) : nodes;
  const items: Item[] = [];
  for (const node of prepared) items.push(...renderNode(node, ctx));
  classifyBinaries(items);
  return items;
}

/** TeX's rule: a binary operator with no left operand (or no right one) is ordinary. */
function classifyBinaries(items: Item[]): void {
  const neighbour = (from: number, step: number): Item | undefined => {
    for (let k = from + step; k >= 0 && k < items.length; k += step) {
      if (items[k].cls !== "space") return items[k];
    }
    return undefined;
  };
  for (let k = 0; k < items.length; k++) {
    const current = items[k];
    if (current.cls !== "bin") continue;
    const previous = neighbour(k, -1);
    const next = neighbour(k, 1);
    if (!previous || ["bin", "op", "rel", "open", "punct"].includes(previous.cls)) {
      current.cls = "ord";
      current.unary = true;
    } else if (!next || ["rel", "close", "punct"].includes(next.cls)) {
      current.cls = "ord";
    }
  }
  for (const current of items) {
    if (current.text === "*") current.box = line(current.cls === "bin" ? "×" : "∗");
  }
}

function isDigits(item: Item | undefined): boolean {
  return item?.kind === "atom" && /^\d$/.test(item.text ?? "");
}

/** Columns between two adjacent items. */
function gap(items: Item[], k: number, ctx: Context): number {
  const a = items[k - 1];
  const b = items[k];
  if (!a || a.cls === "space" || b.cls === "space") return 0;
  if (ctx.script) return a.cls === "op" && (b.cls === "ord" || b.cls === "op") && b.kind !== "delim" ? 1 : 0;
  const A = a.cls;
  const B = b.cls;
  if (A === "rel" && B === "rel") return 0;
  if (A === "rel" || B === "rel") return A === "open" || B === "close" || B === "punct" ? 0 : 1;
  if (A === "bin" || B === "bin") return 1;
  if (A === "punct") {
    // Thousands separators: 1,000 rather than 1, 000.
    if (a.text === "," && isDigits(items[k - 2]) && isDigits(b) && isDigits(items[k + 1]) && isDigits(items[k + 2]) && !isDigits(items[k + 3])) {
      return 0;
    }
    return 1;
  }
  if (A === "op") return B === "open" || B === "punct" || B === "close" || b.kind === "delim" ? 0 : 1;
  if (B === "op") return A === "open" ? 0 : 1;
  if (a.openScript && /^[\p{L}\p{N}]/u.test(boxText(b.box))) return 1;
  if ((a.kind === "frac2d" || b.kind === "frac2d") && A !== "open" && B !== "close" && B !== "punct" && b.text !== ".") return 1;
  return 0;
}

/** Boxes and leading gaps for a list, parenthesising linear fractions that touch a neighbour. */
function arrange(items: Item[], ctx: Context): { boxes: Box[]; gaps: number[] } {
  const gaps = items.map((_, k) => gap(items, k, ctx));
  const boxes = items.map((current, k) => {
    if (current.kind !== "linfrac") return current.box;
    const previous = items[k - 1];
    const next = items[k + 1];
    // Juxtaposed factors (C·A/T, a/b·x) need parentheses; punctuation does not.
    const touchesLeft = previous && gaps[k] === 0 && !previous.unary && /[\p{L}\p{N})\]}′²³¹⁰-⁹ⁿ₀-₉]$/u.test(boxText(previous.box));
    const touchesRight = next && gaps[k + 1] === 0 && /^[\p{L}\p{N}(√∑∫]/u.test(boxText(next.box));
    return touchesLeft || touchesRight ? line(`(${boxText(current.box)})`) : current.box;
  });
  return { boxes, gaps };
}

function joinItems(items: Item[], ctx: Context): Box {
  const { boxes, gaps } = arrange(items, ctx);
  return hcat(boxes, gaps, ctx.nbsp ? NBSP : " ");
}

function isProduct(items: Item[]): boolean {
  if (items.length === 0) return false;
  // Bracketed groups are single factors whatever they contain: f(a, b).
  let depth = 0;
  for (let k = 0; k < items.length; k++) {
    const current = items[k];
    if (current.cls === "open") {
      depth++;
      continue;
    }
    if (current.cls === "close") {
      if (depth === 0) return false;
      depth--;
      continue;
    }
    if (depth > 0) continue;
    const call = current.cls === "op" && (items[k + 1]?.cls === "open" || items[k + 1]?.kind === "delim");
    if (!current.product && !call) return false;
  }
  return depth === 0;
}

function isSimple(items: Item[]): boolean {
  if (items.length === 1) return items[0].simple;
  if (items.length > 1 && items.every(current => current.kind === "atom" && /^[\d.]$/.test(current.text ?? ""))) return true;
  const [first, second] = items;
  if (first?.cls === "op") {
    if (items.length === 2 && second.kind === "delim") return true;
    if (second?.text === "(" && items[items.length - 1].text === ")") {
      let depth = 0;
      for (let k = 1; k < items.length; k++) {
        if (items[k].text === "(") depth++;
        else if (items[k].text === ")" && --depth === 0 && k < items.length - 1) return false;
      }
      return depth === 0;
    }
  }
  return false;
}

function linear(nodes: MathNode[], ctx: Context = LINEAR): string {
  return boxText(joinItems(renderList(nodes, ctx), ctx));
}

// ── Nodes ──────────────────────────────────────────────────────────────

function renderNode(node: MathNode, ctx: Context): Item[] {
  switch (node.type) {
    case "atom":
      return [item(line(node.text), node.cls, "atom", node.cls === "ord", node.cls === "ord", { text: node.text })];
    case "text": {
      const spaced = /\s/.test(node.text.trim());
      return [item(line(node.text), "ord", "text", !spaced, !spaced)];
    }
    case "space":
      return [item(line((ctx.nbsp && node.width === 1 ? NBSP : " ").repeat(node.width)), "space", "space", false, false)];
    case "group": {
      const inner = renderList(node.body, ctx);
      if (inner.length === 0) return [];
      if (inner.length === 1) {
        const only = inner[0];
        return [{ ...only, cls: only.cls === "op" || only.cls === "space" ? only.cls : "ord" }];
      }
      return [item(joinItems(inner, ctx), "ord", "group", isSimple(inner), isProduct(inner))];
    }
    case "scripts":
      return [renderScripts(node, ctx)];
    case "frac":
      return [renderFraction(node.num, node.den, ctx)];
    case "binom": {
      if (ctx.stacked && !ctx.script) {
        const stack = vstack([joinItems(renderList(node.top, ctx), ctx), joinItems(renderList(node.bottom, ctx), ctx)], 0);
        const centred = { ...stack, base: Math.floor((stack.rows.length - 1) / 2) };
        return [item(delimited("(", centred, ")"), "ord", "delim", true, true)];
      }
      return [item(line(`C(${linear(node.top, ctx)}, ${linear(node.bottom, ctx)})`), "ord", "delim", true, true)];
    }
    case "sqrt":
      return [renderSqrt(node.index, node.body, ctx)];
    case "op":
      return [item(line(node.text), "op", "op", true, false, { limits: node.limits })];
    case "delim": {
      const body = joinItems(renderList(node.body, ctx), ctx);
      return [item(delimited(node.left, body, node.right), "ord", "delim", true, true)];
    }
    case "accent": {
      const inner = renderList(node.body, ctx);
      const body = joinItems(inner, ctx);
      if (body.rows.length > 1) return [item(body, "ord", "group", true, true)];
      return [item(line(accent(boxText(body), node.mark, node.spanning)), "ord", "atom", isSimple(inner) || inner.length === 0, true)];
    }
    case "boxed": {
      const body = joinItems(renderList(node.body, ctx), ctx);
      if (!ctx.stacked || ctx.script) return [item(body, "ord", "group", false, false)];
      const bar = "─".repeat(body.width + 2);
      const framed = [`┌${bar}┐`, ...body.rows.map(row => `│ ${row} │`), `└${bar}┘`];
      return [item(makeBox(framed, body.base + 1), "ord", "delim", true, true)];
    }
    case "env":
      return [renderEnvironment(node, ctx)];
    case "newline":
      return ctx.script ? [] : [item(line("  "), "space", "space", false, false)];
    case "tag":
      return [
        item(line("  "), "space", "space", false, false),
        item(line(`(${linear(node.body)})`), "ord", "text", true, true),
      ];
    case "pmod": {
      const body = linear(node.body, ctx);
      return [
        item(line(" "), "space", "space", false, false),
        item(line(node.word ? `(mod ${body})` : `(${body})`), "ord", "text", true, true),
      ];
    }
  }
}

// Some terminals (notably st) draw nothing for combining marks, which would
// silently turn x̄ into x. There, accents without a precomposed character
// are written out instead: bar(x).
let combiningMarks = !/^st(?:-|$)/.test(process.env.TERM ?? "");

/** Whether the terminal draws combining marks (detected from TERM; settable for tests). */
export function setCombiningMarksSupported(supported: boolean): void {
  combiningMarks = supported;
}

function accent(text: string, mark: string, spanning: boolean): string {
  const chars = Array.from(text);
  const marked = chars.length <= 1 || !spanning
    ? text + mark
    : chars.map(char => /[\s\p{M}]/u.test(char) ? char : char + mark).join("");
  const composed = marked.normalize("NFC");
  if (combiningMarks || !/\p{M}/u.test(composed)) return composed;
  return `${ACCENT_NAMES[mark] ?? "accent"}(${text})`;
}

function containsWords(nodes: MathNode[] | null): boolean {
  return (nodes ?? []).some(node =>
    (node.type === "text" && node.text.replace(/\s/g, "").length > 1)
    || (node.type === "op" && !/^[\p{Sm}]$/u.test(node.text) && node.text.length > 1 && !["sum", "prod"].includes(node.text))
    || (node.type === "group" && containsWords(node.body)));
}

function scriptFallback(marker: "^" | "_", text: string, words: boolean): string {
  if (!text) return "";
  const bare = Array.from(text).length === 1 || /^[\d.]+$/.test(text) || (words && /^[\p{L}\p{N}]+$/u.test(text));
  return bare ? `${marker}${text}` : `${marker}(${text})`;
}

function renderScripts(node: Extract<MathNode, { type: "scripts" }>, ctx: Context): Item {
  const baseItems = node.base ? renderNode(node.base, ctx) : [];
  const base: Item = baseItems.length === 1 ? baseItems[0]
    : baseItems.length === 0 ? item(EMPTY, "ord", "atom", true, true)
    : item(joinItems(baseItems, ctx), "ord", "group", isSimple(baseItems), isProduct(baseItems));
  const sup = node.sup ? linear(node.sup, SCRIPT) : null;
  const sub = node.sub ? linear(node.sub, SCRIPT) : null;
  const cls = base.cls === "space" ? "ord" : base.cls;
  const kind: ItemKind = base.kind === "op" ? "op" : "scripted";
  const stackLimits = ctx.stacked && !ctx.script && (node.limits ?? base.limits ?? false);

  if (stackLimits) {
    const parts: Box[] = [];
    if (sup) parts.push(line(sup));
    parts.push(base.box);
    if (sub) parts.push(line(sub));
    return item(vstack(parts, sup ? 1 : 0), cls, kind, true, false, { limits: base.limits });
  }

  const supWords = containsWords(node.sup);
  const subWords = containsWords(node.sub);
  const supText = sup === null ? "" : (!supWords && toSuperscript(sup)) || scriptFallback("^", sup, supWords);
  const subText = sub === null ? "" : (!subWords && toSubscript(sub)) || scriptFallback("_", sub, subWords);

  if (base.box.rows.length > 1) {
    // Tall base: superscript beside the top row, subscript beside the bottom.
    const height = base.box.rows.length;
    const column = Array.from({ length: height }, (_, row) =>
      row === 0 && supText ? supText : row === height - 1 && subText ? subText : "");
    return item(hcat([base.box, makeBox(column, base.box.base)]), cls, kind, true, base.product);
  }

  let baseText = boxText(base.box);
  if (base.kind === "linfrac" || (base.kind === "group" && !base.simple)) baseText = `(${baseText})`;
  const tail = supText || subText;
  const openScript = /^[_^][^(]/.test(tail) && !/\)$/.test(tail);
  return item(line(baseText + subText + supText), cls, kind, true, base.product || base.kind === "linfrac" || base.kind === "group",
    { limits: base.limits, openScript });
}

function digitsOf(nodes: MathNode[]): string | null {
  let digits = "";
  for (const node of nodes) {
    if (node.type === "atom" && /^\d+$/.test(node.text)) digits += node.text;
    else if (node.type === "group") {
      const inner = digitsOf(node.body);
      if (inner === null) return null;
      digits += inner;
    } else return null;
  }
  return digits || null;
}

function vulgarFraction(num: MathNode[], den: MathNode[]): string | null {
  const top = digitsOf(num);
  const bottom = digitsOf(den);
  return top && bottom ? VULGAR_FRACTIONS[`${top}/${bottom}`] ?? null : null;
}

function renderFraction(num: MathNode[], den: MathNode[], ctx: Context): Item {
  const vulgar = vulgarFraction(num, den);
  if (vulgar) return item(line(vulgar), "ord", "vulgar", true, true);
  if (ctx.stacked && !ctx.script) {
    const top = joinItems(renderList(num, ctx), ctx);
    const bottom = joinItems(renderList(den, ctx), ctx);
    const width = Math.max(top.width, bottom.width, 1);
    const rows = [...center(top, width), "─".repeat(width), ...center(bottom, width)];
    return item({ rows, base: top.rows.length, width }, "ord", "frac2d", true, true);
  }
  const numItems = renderList(num, ctx);
  const denItems = renderList(den, ctx);
  if (denItems.length === 0) return item(joinItems(numItems, ctx), "ord", "group", isSimple(numItems), isProduct(numItems));
  const top = boxText(joinItems(numItems, ctx)) || "1";
  const bottom = boxText(joinItems(denItems, ctx));
  const numerator = isProduct(numItems) || numItems.length === 0 ? top : `(${top})`;
  const denominator = isSimple(denItems) ? bottom : `(${bottom})`;
  return item(line(`${numerator}/${denominator}`), "ord", "linfrac", false, false);
}

function renderSqrt(indexNodes: MathNode[] | null, body: MathNode[], ctx: Context): Item {
  const inner = renderList(body, ctx);
  const box = joinItems(inner, ctx);
  const index = indexNodes ? linear(indexNodes, SCRIPT) : "";
  let radical = "√";
  if (index === "3") radical = "∛";
  else if (index === "4") radical = "∜";
  else if (index && index !== "2") {
    const raised = toSuperscript(index);
    if (!raised) {
      return item(line(`root(${index}, ${boxText(box)})`), "ord", "sqrt", true, true);
    }
    radical = `${raised}√`;
  }
  if (box.rows.length > 1) return item(hcat([line(radical), delimited("(", box, ")")]), "ord", "sqrt", true, true);
  const text = boxText(box);
  return item(line(isSimple(inner) ? radical + text : `${radical}(${text})`), "ord", "sqrt", true, true);
}

// ── Delimiters ─────────────────────────────────────────────────────────

const STRETCH: Record<string, [top: string, middle: string, bottom: string, extension?: string]> = {
  "(": ["⎛", "⎜", "⎝"],
  ")": ["⎞", "⎟", "⎠"],
  "[": ["⎡", "⎢", "⎣"],
  "]": ["⎤", "⎥", "⎦"],
  "{": ["⎧", "⎨", "⎩", "⎪"],
  "}": ["⎫", "⎬", "⎭", "⎪"],
  "⌈": ["⎡", "⎢", "⎢"],
  "⌉": ["⎤", "⎥", "⎥"],
  "⌊": ["⎢", "⎢", "⎣"],
  "⌋": ["⎥", "⎥", "⎦"],
  "|": ["│", "│", "│"],
  "‖": ["‖", "‖", "‖"],
};

function stretchedDelimiter(delimiter: string, height: number, base: number): Box {
  if (!delimiter) return { rows: Array.from({ length: height }, () => ""), base, width: 0 };
  if (height === 1) return makeBox([delimiter], 0);
  const pieces = STRETCH[delimiter];
  if (!pieces) {
    return makeBox(Array.from({ length: height }, (_, row) => row === base ? delimiter : " ".repeat(termWidth(delimiter))), base);
  }
  const [top, middle, bottom, extension] = pieces;
  const centre = base > 0 && base < height - 1 ? base : Math.floor(height / 2);
  const rows = Array.from({ length: height }, (_, row) => {
    if (row === 0) return top;
    if (row === height - 1) return bottom;
    if (extension) return row === centre ? middle : extension;
    return middle;
  });
  return makeBox(rows, base);
}

function delimited(left: string, body: Box, right: string): Box {
  const height = body.rows.length;
  const pad = height > 1 ? 1 : 0;
  const padded = pad ? hcat([body], [pad]) : body;
  const inner = pad ? makeBox(padded.rows.map(row => row + " "), padded.base) : padded;
  return hcat([
    stretchedDelimiter(left, height, body.base),
    inner,
    stretchedDelimiter(right, height, body.base),
  ]);
}

function mayBeTall(node: MathNode): boolean {
  switch (node.type) {
    case "frac": return vulgarFraction(node.num, node.den) === null;
    case "binom": case "env": case "boxed": return true;
    case "delim": case "group": case "sqrt": return node.body.some(mayBeTall);
    case "scripts": return Boolean(node.limits) || (node.base?.type === "op" && node.base.limits) || (node.base ? mayBeTall(node.base) : false);
    default: return false;
  }
}

/** In stacked layout, grow plain `(...)`/`[...]` around tall content like `\left(...\right)`. */
function autoDelimiters(nodes: MathNode[]): MathNode[] {
  const out: MathNode[] = [];
  const stack: Array<{ position: number; char: string }> = [];
  for (const node of nodes) {
    if (node.type === "atom" && (node.text === "(" || node.text === "[")) {
      stack.push({ position: out.length, char: node.text });
      out.push(node);
      continue;
    }
    const closeAtom = node.type === "atom" ? node : node.type === "scripts" && node.base?.type === "atom" ? node.base : null;
    const closer = closeAtom && (closeAtom.text === ")" || closeAtom.text === "]") ? closeAtom.text : null;
    if (closer) {
      const opener = closer === ")" ? "(" : "[";
      while (stack.length > 0 && stack[stack.length - 1].char !== opener) stack.pop();
      const open = stack.pop();
      if (open) {
        const body = out.slice(open.position + 1);
        if (body.some(mayBeTall)) {
          out.length = open.position;
          const delimiter: MathNode = { type: "delim", left: opener, right: closer, body };
          out.push(node.type === "scripts" ? { ...node, base: delimiter } : delimiter);
          continue;
        }
      }
    }
    out.push(node);
  }
  return out;
}

// ── Environments ───────────────────────────────────────────────────────

const MATRIX_DELIMITERS: Record<string, [string, string]> = {
  matrix: ["", ""], smallmatrix: ["", ""], pmatrix: ["(", ")"], bmatrix: ["[", "]"], Bmatrix: ["{", "}"],
  vmatrix: ["|", "|"], Vmatrix: ["‖", "‖"], cases: ["{", ""], dcases: ["{", ""], rcases: ["", "}"],
};

function environmentKind(name: string): "matrix" | "cases" | "rows" | "array" | "substack" {
  const bare = name.replace(/\*$/, "");
  if (bare === "cases" || bare === "dcases" || bare === "rcases") return "cases";
  if (bare in MATRIX_DELIMITERS) return "matrix";
  if (bare === "array" || bare === "subarray") return "array";
  if (bare === "substack") return "substack";
  return "rows";
}

function columnAlignments(node: Extract<MathNode, { type: "env" }>, columns: number): Array<"l" | "c" | "r"> {
  const kind = environmentKind(node.name);
  const bare = node.name.replace(/\*$/, "");
  if (kind === "cases") return Array(columns).fill("l");
  if (kind === "array" && node.columns) {
    const spec = node.columns.replace(/[@!>]\{[^}]*\}|[pmb]\{[^}]*\}|\|/g, "").match(/[lcr]/g) ?? [];
    return Array.from({ length: columns }, (_, k) => (spec[k] as "l" | "c" | "r" | undefined) ?? "c");
  }
  if (kind === "rows") {
    if (/^(?:gather|gathered|equation|multline|subequations|displaymath|math)$/.test(bare)) return Array(columns).fill("c");
    if (bare === "eqnarray") return ["r", "c", "l"];
    return Array.from({ length: columns }, (_, k) => (k % 2 === 0 ? "r" : "l"));
  }
  return Array(columns).fill("c");
}

function columnGap(node: Extract<MathNode, { type: "env" }>, column: number): number {
  if (column === 0) return 0;
  const kind = environmentKind(node.name);
  if (kind === "rows") return node.name.startsWith("eqnarray") ? 1 : column % 2 === 0 ? 3 : 0;
  return 2;
}

/** Render one environment cell; `&=` keeps the relation's leading space. */
function renderCell(cell: MathNode[], ctx: Context, leadingRelationSpace: boolean): Box {
  const items = renderList(cell, ctx);
  const box = joinItems(items, ctx);
  if (leadingRelationSpace && (items[0]?.cls === "rel" || items[0]?.cls === "bin")) return hcat([box], [1]);
  return box;
}

function stripTrailingPunctuation(text: string): string {
  return text.replace(/[,;.]\s*$/, "");
}

function renderEnvironment(node: Extract<MathNode, { type: "env" }>, ctx: Context): Item {
  const kind = environmentKind(node.name);
  const bare = node.name.replace(/\*$/, "");
  const [left, right] = MATRIX_DELIMITERS[bare] ?? ["", ""];

  if (!ctx.stacked || ctx.script) {
    let text: string;
    if (kind === "rows") {
      text = node.rows.map(row => linear(row.flat(), ctx)).filter(Boolean).join("; ");
    } else if (kind === "substack") {
      text = node.rows.map(row => linear(row.flat(), ctx)).join(", ");
    } else if (kind === "cases") {
      text = (left || "{") + node.rows.map(row => {
        const [value, ...conditions] = row.map(cell => linear(cell, ctx));
        const condition = stripTrailingPunctuation(conditions.filter(Boolean).join(" "));
        const head = stripTrailingPunctuation(value ?? "");
        return condition ? `${head}, ${condition}` : head;
      }).join("; ") + (right || (left ? "}" : ""));
    } else {
      const [open, close] = kind === "array" || (!left && !right) ? ["[", "]"] : [left, right];
      text = open + node.rows.map(row => row.map(cell => linear(cell, ctx)).join(", ")).join("; ") + close;
    }
    return item(line(text), "ord", "env", true, true);
  }

  const columns = Math.max(...node.rows.map(row => row.length));
  const align = columnAlignments(node, columns);
  const cells = node.rows.map(row => Array.from({ length: columns }, (_, column) =>
    renderCell(row[column] ?? [], ctx, kind === "rows" && column % 2 === 1)));
  const widths = Array.from({ length: columns }, (_, column) => Math.max(...cells.map(row => row[column].width)));
  const tall = cells.some(row => row.some(cell => cell.rows.length > 1));
  const rows: string[] = [];
  cells.forEach((row, index) => {
    if (index > 0 && tall) rows.push("");
    const aligned = row.map((cell, column) => {
      const slack = widths[column] - cell.width;
      const leftPad = align[column] === "l" ? 0 : align[column] === "r" ? slack : Math.floor(slack / 2);
      return hcat([cell, makeBox([""])], [leftPad, slack - leftPad]);
    });
    rows.push(...hcat(aligned, aligned.map((_, column) => columnGap(node, column))).rows);
  });
  const grid = makeBox(rows.map(row => row.trimEnd()), Math.floor((rows.length - 1) / 2));
  if (!left && !right) return item(grid, "ord", "env", true, true);
  return item(delimited(left, grid, right), "ord", "env", true, true);
}

// ── Public layout ──────────────────────────────────────────────────────

function splitLines(nodes: MathNode[]): MathNode[][] {
  const lines: MathNode[][] = [[]];
  for (const node of nodes) {
    if (node.type === "newline") lines.push([]);
    else lines[lines.length - 1].push(node);
  }
  return lines.filter((current, index) => current.length > 0 || index === 0);
}

/**
 * Single-line Unicode rendering for inline math. With `nbsp`, spaces are
 * no-break spaces except after top-level relations and binary operators,
 * the only places TeX breaks inline math across lines.
 */
export function layoutInline(nodes: MathNode[], nbsp = false): string {
  const ctx: Context = { ...LINEAR, nbsp };
  return splitLines(nodes).map(current => {
    const items = renderList(current, ctx);
    const { boxes, gaps } = arrange(items, ctx);
    return boxes.map((box, k) => {
      const previous = items[k - 1];
      const breakable = !nbsp || previous?.cls === "rel" || previous?.cls === "bin";
      return (breakable ? " " : NBSP).repeat(gaps[k]) + boxText(box);
    }).join("").trim();
  }).filter(Boolean).join("; ");
}

/** Lines of a display expression: top-level `\\` rows or the rows of one row environment. */
function displayLines(nodes: MathNode[]): { lines: MathNode[][]; grid: MathNode | null } {
  const significant = nodes.filter(node => node.type !== "space");
  const only = significant.length === 1 ? significant[0] : null;
  if (only?.type === "env" && isRowEnvironment(only.name)) {
    return { lines: only.rows.map(row => row.flat()), grid: only };
  }
  return { lines: splitLines(nodes), grid: null };
}

interface Piece {
  text: string;
  gap: number;
  /** Preference for breaking before this piece: 4 after \quad, 3 relation, 2 binary operator, 1 after punctuation. */
  priority: number;
}

/** Break a linear expression before relations/operators to fit `width` columns. */
function breakLinear(nodes: MathNode[], width: number): string[] {
  const items = renderList(nodes, LINEAR);
  const { boxes, gaps } = arrange(items, LINEAR);
  const pieces: Piece[] = items.map((current, k) => ({
    text: boxText(boxes[k]),
    gap: gaps[k],
    priority: current.cls === "space" ? 0
      : items[k - 1]?.cls === "space" && termWidth(boxText(items[k - 1].box)) >= 2 ? 4
      : current.cls === "rel" ? 3 : current.cls === "bin" ? 2 : items[k - 1]?.cls === "punct" ? 1 : 0,
  }));
  const indent = width >= 24 ? "  " : "";
  const lineText = (list: Piece[], first: boolean) =>
    (first ? "" : indent) + list.map((piece, k) => (k === 0 ? "" : " ".repeat(piece.gap)) + piece.text).join("").trimEnd();
  if (termWidth(lineText(pieces, true)) <= width) return [lineText(pieces, true)];

  const lines: string[] = [];
  const flush = (list: Piece[]) => {
    let rest = lineText(list, lines.length === 0);
    // A single piece wider than the terminal is cut as a last resort,
    // preferably at a space inside it.
    while (termWidth(rest) > width) {
      let [chunk, tail] = sliceByWidth(rest, width);
      if (!chunk) {
        chunk = rest.slice(0, 1);
        tail = rest.slice(1);
      }
      const space = chunk.lastIndexOf(" ");
      if (space > Math.max(indent.length, chunk.length * 0.3)) {
        tail = chunk.slice(space + 1) + tail;
        chunk = chunk.slice(0, space);
      }
      lines.push(chunk.trimEnd());
      rest = indent + tail;
    }
    if (rest.trim()) lines.push(rest);
  };

  let current: Piece[] = [];
  for (const piece of pieces) {
    // Explicit spacing never starts a continuation line.
    if (current.length === 0 && lines.length > 0 && !piece.text.trim()) continue;
    // A piece too wide for any line stays with what precedes it ("= …") and
    // is cut when flushed, rather than leaving a lone operator behind.
    const fitsAlone = termWidth(piece.text) <= width - indent.length;
    while (current.length > 0 && fitsAlone) {
      const available = width - (lines.length === 0 ? 0 : indent.length);
      if (termWidth(lineText([...current, piece], true)) <= available) break;
      // Prefer the strongest break point that keeps a reasonably full line.
      let best = -1;
      for (let k = current.length - 1; k > 0; k--) {
        if (termWidth(lineText(current.slice(0, k), true)) < available * 0.3) break;
        if (current[k].priority > 0 && (best < 0 || current[k].priority > current[best].priority)) best = k;
      }
      if (best > 0) {
        flush(current.slice(0, best));
        current = current.slice(best);
        while (current.length > 0 && !current[0].text.trim()) current.shift();
      } else {
        flush(current);
        current = [];
      }
    }
    current.push(piece);
  }
  if (current.length > 0) flush(current);
  return lines;
}

export interface DisplayLayout {
  rows: string[];
  /** Row holding the baseline of the last line (where trailing punctuation belongs). */
  lastBase: number;
}

/** Display rows, at most `width` columns wide when a narrower layout exists. */
export function layoutDisplay(nodes: MathNode[], width = Infinity): DisplayLayout {
  const { lines, grid } = displayLines(nodes);
  const done = (rows: string[], lastBase: number): DisplayLayout => ({ rows: rows.map(row => row.trimEnd()), lastBase });
  if (grid) {
    const box = renderEnvironment(grid as Extract<MathNode, { type: "env" }>, STACKED).box;
    if (box.width <= width) {
      // The last row of a grid sits at its bottom; find its baseline by
      // laying out that row alone.
      const lastRow = joinItems(renderList(lines[lines.length - 1] ?? [], STACKED), STACKED);
      return done(box.rows, box.rows.length - (lastRow.rows.length - lastRow.base));
    }
  } else {
    const boxes = lines.map(current => joinItems(renderList(current, STACKED), STACKED));
    if (boxes.every(box => box.width <= width)) {
      const rows: string[] = [];
      let lastBase = 0;
      boxes.forEach((box, index) => {
        if (index > 0 && (box.rows.length > 1 || boxes[index - 1].rows.length > 1)) rows.push("");
        lastBase = rows.length + box.base;
        rows.push(...box.rows);
      });
      return done(rows, lastBase);
    }
  }
  const rows: string[] = [];
  let lastBase = 0;
  for (const current of lines) {
    const stacked = joinItems(renderList(current, STACKED), STACKED);
    if (stacked.width <= width) {
      lastBase = rows.length + stacked.base;
      rows.push(...stacked.rows);
    } else {
      const broken = breakLinear(current, width);
      rows.push(...broken);
      lastBase = rows.length - 1;
    }
  }
  return done(rows, lastBase);
}
