/**
 * Newline-delimited stream framing that scans each chunk once.
 *
 * Re-searching `partial + chunk` from its start made a long line quadratic:
 * a 5 MB line (an image in Claude Code stream-json, a pasted image command)
 * arriving in 64 KB chunks cost ~47 ms of event-loop time, 20 MB ~600 ms.
 */
export class LineSplitter {
  private parts: string[] = [];

  /** Call `onLine` for every line this chunk completes, without its "\n". */
  push(chunk: string, onLine: (line: string) => void): void {
    let from = 0;
    for (let newline = chunk.indexOf("\n"); newline !== -1; newline = chunk.indexOf("\n", from)) {
      let line = chunk.slice(from, newline);
      if (this.parts.length > 0) {
        this.parts.push(line);
        line = this.parts.join("");
        this.parts = [];
      }
      from = newline + 1;
      onLine(line);
    }
    if (from < chunk.length) this.parts.push(from === 0 ? chunk : chunk.slice(from));
  }
}
