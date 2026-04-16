/**
 * Shell command segmentation helpers.
 *
 * Splits a single shell command line on top-level control operators while
 * respecting quotes and backslash escaping. This is intentionally minimal and
 * only supports the syntax needed by tool-call rendering.
 */

export interface ShellSegment {
  text: string;
  start: number;
  separator: string;
}

export function splitTopLevelShellSegments(line: string): ShellSegment[] {
  const segments: ShellSegment[] = [];
  let start = 0;
  let i = 0;
  let quote: "'" | '"' | null = null;

  while (i < line.length) {
    const ch = line[i];

    if (quote === "'") {
      if (ch === "'") quote = null;
      i++;
      continue;
    }

    if (quote === '"') {
      if (ch === "\\" && i + 1 < line.length) {
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

    if (ch === "\\" && i + 1 < line.length) {
      i += 2;
      continue;
    }

    const separator = ch === ";"
      ? ";"
      : ch === "&"
        ? (line[i + 1] === "&" ? "&&" : "")
        : ch === "|"
          ? (line[i + 1] === "|" ? "||" : line[i + 1] === "&" ? "|&" : "|")
          : "";
    if (separator) {
      segments.push({ text: line.slice(start, i), start, separator });
      i += separator.length;
      start = i;
      continue;
    }

    i++;
  }

  segments.push({ text: line.slice(start), start, separator: "" });
  return segments;
}
