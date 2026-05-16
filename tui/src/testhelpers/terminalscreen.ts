/**
 * Minimal terminal-screen model for TUI process tests.
 *
 * This intentionally implements only the ANSI sequences emitted by the retained
 * renderer (absolute cursor moves, clear-line/screen, and color/mode no-ops).
 * It gives e2e tests a stable way to assert what is visible after a stream of
 * stdout bytes without depending on screenshots or a real PTY.
 */
export class TerminalScreen {
  private rows: string[][];
  private row = 0;
  private col = 0;

  constructor(private readonly rowCount = 24, private readonly colCount = 80) {
    this.rows = Array.from({ length: rowCount }, () => Array(colCount).fill(" "));
  }

  feed(text: string): void {
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "\x1b") {
        i = this.consumeEscape(text, i);
        continue;
      }

      if (ch === "\r") {
        this.col = 0;
        i++;
        continue;
      }
      if (ch === "\n") {
        this.row = Math.min(this.row + 1, this.rowCount - 1);
        i++;
        continue;
      }
      if (ch >= " ") {
        if (this.row >= 0 && this.row < this.rowCount && this.col >= 0 && this.col < this.colCount) {
          this.rows[this.row][this.col] = ch;
        }
        this.col = Math.min(this.col + 1, this.colCount - 1);
      }
      i++;
    }
  }

  plainRows(): string[] {
    return this.rows.map(row => row.join(""));
  }

  private consumeEscape(text: string, start: number): number {
    if (text[start + 1] === "[") {
      let end = start + 2;
      while (end < text.length && (text.charCodeAt(end) < 0x40 || text.charCodeAt(end) > 0x7e)) end++;
      if (end >= text.length) return text.length;
      this.handleCsi(text.slice(start + 2, end), text[end]);
      return end + 1;
    }

    // OSC: ESC ] ... BEL or ESC ] ... ST.  We do not render these payloads.
    if (text[start + 1] === "]") {
      const bel = text.indexOf("\x07", start + 2);
      const st = text.indexOf("\x1b\\", start + 2);
      const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
      return end === -1 ? text.length : end + (end === st ? 2 : 1);
    }

    // Unknown two-byte escape: skip it.
    return start + 2;
  }

  private handleCsi(params: string, final: string): void {
    const cleanParams = params.replace(/^\?/, "");
    const numbers = cleanParams.split(";").map(part => part === "" ? NaN : Number.parseInt(part, 10));
    if (final === "H" || final === "f") {
      this.row = Math.max(0, Math.min((Number.isFinite(numbers[0]) ? numbers[0] : 1) - 1, this.rowCount - 1));
      this.col = Math.max(0, Math.min((Number.isFinite(numbers[1]) ? numbers[1] : 1) - 1, this.colCount - 1));
    } else if (final === "G") {
      this.col = Math.max(0, Math.min((Number.isFinite(numbers[0]) ? numbers[0] : 1) - 1, this.colCount - 1));
    } else if (final === "K") {
      const mode = Number.isFinite(numbers[0]) ? numbers[0] : 0;
      if (mode === 2) this.rows[this.row].fill(" ");
      else if (mode === 1) this.rows[this.row].fill(" ", 0, this.col + 1);
      else this.rows[this.row].fill(" ", this.col);
    } else if (final === "J") {
      const mode = Number.isFinite(numbers[0]) ? numbers[0] : 0;
      if (mode === 2) for (const row of this.rows) row.fill(" ");
    } else if (final === "A") {
      this.row = Math.max(0, this.row - (Number.isFinite(numbers[0]) ? numbers[0] : 1));
    } else if (final === "B") {
      this.row = Math.min(this.rowCount - 1, this.row + (Number.isFinite(numbers[0]) ? numbers[0] : 1));
    } else if (final === "C") {
      this.col = Math.min(this.colCount - 1, this.col + (Number.isFinite(numbers[0]) ? numbers[0] : 1));
    } else if (final === "D") {
      this.col = Math.max(0, this.col - (Number.isFinite(numbers[0]) ? numbers[0] : 1));
    }
  }
}
