/**
 * Plain terminal word wrapping helpers.
 *
 * Wrap results retain continuation metadata so history yanks can reconstruct
 * logical text without adding or losing separators at soft-wrap boundaries.
 */
export interface WrapResult {
  lines: string[];
  /** true for visual lines that are continuations of the previous logical line. */
  cont: boolean[];
  /** separator to reinsert before each continuation line when reconstructing plain text. */
  join: string[];
}

export function wordWrap(text: string, width: number): WrapResult {
  if (width <= 0) return { lines: [text], cont: [false], join: [""] };
  const lines: string[] = [];
  const cont: boolean[] = [];
  const join: string[] = [];

  for (const rawLine of text.split("\n")) {
    if (rawLine.length <= width) {
      lines.push(rawLine);
      cont.push(false);
      join.push("");
      continue;
    }
    let line = rawLine;
    let first = true;
    let pendingJoin = "";
    while (line.length > width) {
      let breakAt = line.lastIndexOf(" ", width);
      const nextJoin = breakAt > 0 ? " " : "";
      if (breakAt <= 0) breakAt = width;
      lines.push(line.slice(0, breakAt));
      cont.push(!first);
      join.push(first ? "" : pendingJoin);
      first = false;
      line = line.slice(breakAt).trimStart();
      pendingJoin = nextJoin;
    }
    if (line) {
      lines.push(line);
      cont.push(!first);
      join.push(first ? "" : pendingJoin);
    }
  }

  return { lines, cont, join };
}
