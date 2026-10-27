/**
 * Turn an edited, expanded tool text back into its stored template.
 *
 * /instructions tools shows text as the model gets it, with placeholders
 * ({{repoRoot}}, a manifest's <exocortex-source-dir>) already expanded. When
 * the owner saves an edit, every placeholder whose expansion survived the
 * edit untouched is written back as the placeholder, so the file stays
 * portable (the Mac's checkout path differs from whale's). Text the owner
 * typed or changed is stored as typed.
 */

/** A placeholder as written in the template, and what it expands to here. */
export type TemplateToken = readonly [token: string, value: string];

type Part = { literal: string } | { token: string; value: string };

/** Split a template at its placeholders (leftmost, then longest token first). */
export function templateParts(template: string, tokens: readonly TemplateToken[]): Part[] {
  const parts: Part[] = [];
  const usable = tokens.filter(([token]) => token.length > 0);
  let literal = "";
  let i = 0;
  while (i < template.length) {
    let hit: TemplateToken | null = null;
    for (const candidate of usable) {
      if (template.startsWith(candidate[0], i) && (!hit || candidate[0].length > hit[0].length)) hit = candidate;
    }
    if (hit) {
      if (literal) parts.push({ literal });
      literal = "";
      parts.push({ token: hit[0], value: hit[1] });
      i += hit[0].length;
    } else {
      literal += template[i];
      i++;
    }
  }
  if (literal) parts.push({ literal });
  return parts;
}

export function expandTemplate(template: string, tokens: readonly TemplateToken[]): string {
  return templateParts(template, tokens).map(part => "literal" in part ? part.literal : part.value).join("");
}

/** Edits larger than this are matched only at their common start and end. */
const MAX_DIFF_EDITS = 1000;

/**
 * For each character of `a`, the index of the same character in `b` when it
 * is kept by a shortest edit script (Myers), or -1 when it is deleted.
 */
export function matchCharacters(a: string, b: string): Int32Array {
  const map = new Int32Array(a.length).fill(-1);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    map[prefix] = prefix;
    prefix++;
  }
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
    map[a.length - 1 - suffix] = b.length - 1 - suffix;
    suffix++;
  }
  const A = a.slice(prefix, a.length - suffix);
  const B = b.slice(prefix, b.length - suffix);
  const n = A.length;
  const m = B.length;
  if (n === 0 || m === 0) return map;

  const limit = Math.min(n + m, MAX_DIFF_EDITS);
  const off = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  // trace[d] holds v[k] for k in [-d-1, d+1] as it was before step d.
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return map;

  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d];
    const at = (k: number) => prev[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      map[prefix + x] = prefix + y;
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    map[prefix + x] = prefix + y;
  }
  return map;
}

/**
 * The template for `edited`, given the template it was expanded from: kept
 * placeholders stay placeholders, everything else is literal. `edited` is
 * returned as is when `template` does not expand to `expanded`.
 */
export function retemplate(template: string, tokens: readonly TemplateToken[], expanded: string, edited: string): string {
  const parts = templateParts(template, tokens);
  if (parts.map(part => "literal" in part ? part.literal : part.value).join("") !== expanded) return edited;
  if (!parts.some(part => "token" in part)) return edited;

  const map = matchCharacters(expanded, edited);
  const kept: Array<{ start: number; end: number; token: string }> = [];
  let at = 0;
  for (const part of parts) {
    if ("literal" in part) {
      at += part.literal.length;
      continue;
    }
    const length = part.value.length;
    if (length > 0) {
      const start = map[at];
      let whole = start !== -1;
      for (let i = 1; whole && i < length; i++) whole = map[at + i] === start + i;
      if (whole) kept.push({ start, end: start + length, token: part.token });
    } else {
      // An empty value: keep it where its neighbours still meet.
      const left = at === 0 ? 0 : map[at - 1] === -1 ? null : map[at - 1] + 1;
      const right = at === expanded.length ? edited.length : map[at] === -1 ? null : map[at];
      const position = left !== null && right !== null ? (left === right ? left : null) : left ?? right;
      if (position !== null) kept.push({ start: position, end: position, token: part.token });
    }
    at += length;
  }

  let out = "";
  let cursor = 0;
  for (const { start, end, token } of kept) {
    if (start < cursor) continue;
    out += edited.slice(cursor, start) + token;
    cursor = end;
  }
  return out + edited.slice(cursor);
}
