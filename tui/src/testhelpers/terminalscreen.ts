import { nextGrapheme } from "../textwidth";

/** A Kitty graphics placement as the terminal holds it (zero-based top-left cell). */
export interface TerminalPlacement {
  imageId: number;
  placementId: number;
  row: number;
  col: number;
  /** The placement's controls other than its ids, e.g. `c=48,r=12,C=1,z=1`. */
  controls: string;
}

export interface TerminalScreenOptions {
  /**
   * Model DECAWM like st: glyphs take their terminal width, and printing past
   * the last column wraps onto the next row (a row written wider than the
   * screen spills there). Off by default: the cursor clamps at the last column.
   */
  autowrap?: boolean;
}

/**
 * Minimal terminal-screen model for TUI process tests.
 *
 * This intentionally implements only the ANSI sequences emitted by the retained
 * renderer (absolute cursor moves, clear-line/screen, scroll regions, and
 * color/mode no-ops). Kitty placements are tracked like st does: anchored to
 * their top row, they move with region scrolls and vanish with scrolled-out rows.
 * It gives e2e tests a stable way to assert what is visible after a stream of
 * stdout bytes without depending on screenshots or a real PTY.
 */
export class TerminalScreen {
  private rows: string[][];
  private row = 0;
  private col = 0;
  /** DECSTBM scroll margins (zero-based, inclusive). */
  private top = 0;
  private bottom: number;
  private readonly autowrap: boolean;
  /** Autowrap mode: the last column was written; the next glyph wraps first. */
  private wrapNext = false;
  /** Autowrap mode: how many times output ran past the last column. */
  autoWrapCount = 0;
  /** Kitty placements by `imageId:placementId`. */
  private readonly placementsByKey = new Map<string, TerminalPlacement>();

  constructor(private readonly rowCount = 24, private readonly colCount = 80, options: TerminalScreenOptions = {}) {
    this.rows = Array.from({ length: rowCount }, () => Array(colCount).fill(" "));
    this.bottom = rowCount - 1;
    this.autowrap = options.autowrap ?? false;
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
        this.wrapNext = false;
        i++;
        continue;
      }
      if (ch === "\n") {
        this.lineFeed();
        i++;
        continue;
      }
      if (this.autowrap && ch >= " ") {
        i = this.printWrapping(text, i);
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

  private lineFeed(): void {
    if (this.row === this.bottom) this.scrollRegion(1);
    else this.row = Math.min(this.row + 1, this.rowCount - 1);
  }

  /** Print one grapheme with st's pending-wrap semantics; returns the next index. */
  private printWrapping(text: string, start: number): number {
    const [width, end] = nextGrapheme(text, start);
    if (width === 0) return end;
    if (this.wrapNext || this.col + width > this.colCount) {
      this.autoWrapCount++;
      this.col = 0;
      this.lineFeed();
    }
    this.wrapNext = false;
    this.rows[this.row][this.col] = text.slice(start, end);
    if (width === 2 && this.col + 1 < this.colCount) this.rows[this.row][this.col + 1] = "";
    if (this.col + width < this.colCount) this.col += width;
    else {
      this.col = this.colCount - 1;
      this.wrapNext = true;
    }
    return end;
  }

  /** Move the rows between the margins up (positive) or down (negative), exposing blank rows. */
  private scrollRegion(amount: number): void {
    for (const [key, placement] of this.placementsByKey) {
      if (placement.row < this.top || placement.row > this.bottom) continue;
      placement.row -= amount;
      if (placement.row < this.top || placement.row > this.bottom) this.placementsByKey.delete(key);
    }
    const blank = () => Array(this.colCount).fill(" ");
    for (let n = 0; n < Math.abs(amount); n++) {
      if (amount > 0) {
        this.rows.splice(this.top, 1);
        this.rows.splice(this.bottom, 0, blank());
      } else {
        this.rows.splice(this.bottom, 1);
        this.rows.splice(this.top, 0, blank());
      }
    }
  }

  /** Current placements, sorted by key. */
  placements(): TerminalPlacement[] {
    return [...this.placementsByKey.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, placement]) => ({ ...placement }));
  }

  private graphicsCommand(controlText: string): void {
    const controls = new Map(controlText.split(",").map(pair => pair.split("=") as [string, string]));
    const imageId = Number(controls.get("i"));
    const placementId = Number(controls.get("p") ?? 0);
    const action = controls.get("a") ?? "t";
    if (action === "p") {
      const rest = controlText.split(",").filter(pair => !/^(a|i|p|q)=/.test(pair)).join(",");
      this.placementsByKey.set(`${imageId}:${placementId}`, { imageId, placementId, row: this.row, col: this.col, controls: rest });
    } else if (action === "d") {
      const what = controls.get("d") ?? "a";
      for (const [key, placement] of this.placementsByKey) {
        if (placement.imageId !== imageId && what !== "a" && what !== "A") continue;
        if ((what === "i") && controls.has("p") && placement.placementId !== placementId) continue;
        this.placementsByKey.delete(key);
      }
    }
  }

  plainRows(): string[] {
    return this.rows.map(row => row.join(""));
  }

  /** The glyph at a zero-based cell; "" for the right half of a wide glyph. */
  cell(row: number, col: number): string {
    return this.rows[row]?.[col] ?? "";
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

    // Reverse index: up one row, scrolling the region down at its top margin.
    if (text[start + 1] === "M") {
      if (this.row === this.top) this.scrollRegion(-1);
      else this.row = Math.max(0, this.row - 1);
      return start + 2;
    }

    // APC (Kitty graphics): ESC _ ... ST.  Image payloads draw no text.
    if (text[start + 1] === "_") {
      const st = text.indexOf("\x1b\\", start + 2);
      if (text[start + 2] === "G" && st !== -1) {
        const body = text.slice(start + 3, st);
        const semicolon = body.indexOf(";");
        this.graphicsCommand(semicolon === -1 ? body : body.slice(0, semicolon));
      }
      return st === -1 ? text.length : st + 2;
    }

    // Unknown two-byte escape: skip it.
    return start + 2;
  }

  private handleCsi(params: string, final: string): void {
    const cleanParams = params.replace(/^\?/, "");
    const numbers = cleanParams.split(";").map(part => part === "" ? NaN : Number.parseInt(part, 10));
    if (final !== "m") this.wrapNext = false;
    if (final === "H" || final === "f") {
      this.row = Math.max(0, Math.min((Number.isFinite(numbers[0]) ? numbers[0] : 1) - 1, this.rowCount - 1));
      this.col = Math.max(0, Math.min((Number.isFinite(numbers[1]) ? numbers[1] : 1) - 1, this.colCount - 1));
    } else if (final === "G") {
      this.col = Math.max(0, Math.min((Number.isFinite(numbers[0]) ? numbers[0] : 1) - 1, this.colCount - 1));
    } else if ((final === "S" || final === "T") && !params.startsWith("?")) {
      // SU/SD scroll the region regardless of the cursor, which stays put.
      const amount = Number.isFinite(numbers[0]) ? numbers[0] : 1;
      this.scrollRegion(final === "S" ? amount : -amount);
    } else if (final === "r") {
      this.top = Number.isFinite(numbers[0]) ? Math.max(0, numbers[0] - 1) : 0;
      this.bottom = Number.isFinite(numbers[1]) ? Math.min(this.rowCount - 1, numbers[1] - 1) : this.rowCount - 1;
      this.row = 0;
      this.col = 0;
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
