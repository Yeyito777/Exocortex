/**
 * Terminal input parser.
 *
 * Converts raw stdin bytes into structured input events
 * (keyboard, mouse, and bracketed paste).
 */

export interface KeyEvent {
  type: "char" | "enter" | "tab" | "backtab" | "backspace" | "delete"
      | "left" | "right" | "home" | "end"
      | "up" | "down"
      | "ctrl-b" | "ctrl-c" | "ctrl-d" | "ctrl-e" | "ctrl-f"
      | "ctrl-j" | "ctrl-k" | "ctrl-l" | "ctrl-m" | "ctrl-n"
      | "ctrl-o" | "ctrl-p" | "ctrl-q" | "ctrl-r" | "ctrl-s" | "ctrl-u" | "ctrl-v" | "ctrl-w" | "ctrl-y"
      | "ctrl-shift-o"
      | "shift-enter"
      | "f14" | "f15" | "f16" | "f17" | "f18" | "f19"
      | "f20" | "f21" | "f22" | "f23" | "f24"
      | "escape"
      | "paste"
      | "unknown";
  char?: string;
  /** For paste events: the full pasted text. */
  text?: string;
}

export interface MouseEvent {
  type: "mouse";
  /** 0=left, 1=middle, 2=right, 3=none (motion only), 64=scroll_up, 65=scroll_down */
  button: number;
  /** 1-based column */
  col: number;
  /** 1-based row */
  row: number;
  action: "press" | "release" | "motion";
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
}

/** Union of all input events from the terminal. */
export type InputEvent = KeyEvent | MouseEvent;

/**
 * CSI u (kitty keyboard protocol) lookup table.
 * Key: the params portion of ESC [ <params> u  (e.g. "109;5")
 * Value: the KeyEvent type it maps to.
 * Codepoints are always lowercase. Shift is in the modifier bits (1-based: 2=shift, 5=ctrl, 6=ctrl+shift).
 */
const CSI_U_MAP: Record<string, KeyEvent["type"]> = {
  // Keys that become ambiguous under kitty keyboard protocol flag 1 (disambiguate).
  // Without these, Enter/Tab/Backspace/Escape go dead on kitty.
  "13":    "enter",           // Enter (CR=13, no modifiers)
  "9":     "tab",             // Tab (HT=9, no modifiers)
  "9;2":   "backtab",         // Shift+Tab
  "127":   "backspace",       // Backspace (DEL=127, no modifiers)
  "27":    "escape",          // Escape (ESC=27, no modifiers)

  // Ctrl+letter keys — kitty sends these as CSI u instead of raw bytes 1-26
  "98;5":  "ctrl-b",         // Ctrl+B (b=98)
  "99;5":  "ctrl-c",         // Ctrl+C (c=99)
  "100;5": "ctrl-d",         // Ctrl+D (d=100)
  "101;5": "ctrl-e",         // Ctrl+E (e=101)
  "102;5": "ctrl-f",         // Ctrl+F (f=102)
  "106;5": "ctrl-j",         // Ctrl+J (j=106)
  "107;5": "ctrl-k",         // Ctrl+K (k=107)
  "108;5": "ctrl-l",         // Ctrl+L (l=108)
  "109;5": "ctrl-m",         // Ctrl+M (m=109)
  "110;5": "ctrl-n",         // Ctrl+N (n=110)
  "111;5": "ctrl-o",         // Ctrl+O (o=111)
  "112;5": "ctrl-p",         // Ctrl+P (p=112)
  "113;5": "ctrl-q",         // Ctrl+Q (q=113)
  "114;5": "ctrl-r",         // Ctrl+R (r=114)
  "115;5": "ctrl-s",         // Ctrl+S (s=115)
  "117;5": "ctrl-u",         // Ctrl+U (u=117)
  "118;5": "ctrl-v",         // Ctrl+V (v=118)
  "119;5": "ctrl-w",         // Ctrl+W (w=119)
  "121;5": "ctrl-y",         // Ctrl+Y (y=121)

  // Modified keys — only distinguishable via CSI u
  "111;6": "ctrl-shift-o",   // Ctrl+Shift+O (o=111)
  "13;2":  "shift-enter",    // Shift+Enter (CR=13, shift=2)
};

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * Accumulates stdin chunks across bracketed-paste boundaries.
 *
 * Terminals wrap pasted text in \x1b[200~ … \x1b[201~, but large
 * pastes arrive in multiple stdin chunks. Without buffering, chunks
 * after the first are parsed as individual keystrokes — newlines
 * become Enter (submit). This class holds data until the paste-end
 * marker arrives, then releases the complete buffer for parsing.
 */
export class PasteBuffer {
  private buf = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Safety timeout (ms) — flush incomplete paste so the UI never locks up. */
  private static TIMEOUT = 2000;

  /**
   * @param onFlush Called when the safety timeout fires and buffered
   *   data must be flushed. Without this the UI would lock up if the
   *   paste-end marker never arrives.
   */
  constructor(private onFlush: (data: string) => void) {}

  /**
   * Feed a stdin chunk. Returns the string to parse now, or null if
   * we're still accumulating a multi-chunk paste.
   */
  feed(data: Buffer): string | null {
    this.buf += data.toString("utf-8");

    // Not inside a paste — return immediately
    const startIdx = this.buf.indexOf(PASTE_START);
    if (startIdx === -1) return this.drain();

    // Inside a paste — do we have the end marker yet?
    if (this.buf.indexOf(PASTE_END, startIdx) !== -1) return this.drain();

    // Still waiting for paste end — start/reset the safety timeout
    this.resetTimer();
    return null;
  }

  /** Clear the buffer and return its contents, or null if empty. */
  private drain(): string | null {
    if (!this.buf) return null;
    const out = this.buf;
    this.buf = "";
    this.clearTimer();
    return out;
  }

  private resetTimer(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      const data = this.drain();
      if (data) this.onFlush(data);
    }, PasteBuffer.TIMEOUT);
  }

  private clearTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}

/**
 * SGR mouse button mask: extracts the button number from the Pb field.
 * Bits 0-1 = button (0=left, 1=middle, 2=right, 3=none).
 * Bits 6-7 = high button bits (64=scroll up, 65=scroll down).
 * Bits 2-5 are modifiers/motion and are masked off.
 */
const SGR_BUTTON_MASK = 0x43;

export function parseInput(data: Buffer | string): InputEvent[] {
  const events: InputEvent[] = [];
  const str = typeof data === "string" ? data : data.toString("utf-8");
  let i = 0;

  while (i < str.length) {
    // Bracketed paste: everything between \x1b[200~ and \x1b[201~ is one paste event
    if (str.startsWith(PASTE_START, i)) {
      i += PASTE_START.length;
      const endIdx = str.indexOf(PASTE_END, i);
      if (endIdx !== -1) {
        events.push({ type: "paste", text: str.slice(i, endIdx) });
        i = endIdx + PASTE_END.length;
      } else {
        // No closing bracket — treat rest as paste
        events.push({ type: "paste", text: str.slice(i) });
        i = str.length;
      }
      continue;
    }

    const ch = str[i];
    const code = str.charCodeAt(i);

    // Tab
    if (code === 9)  { events.push({ type: "tab" }); i++; continue; }
    // Ctrl keys (byte order)
    if (code === 2)  { events.push({ type: "ctrl-b" }); i++; continue; }
    if (code === 3)  { events.push({ type: "ctrl-c" }); i++; continue; }
    if (code === 4)  { events.push({ type: "ctrl-d" }); i++; continue; }
    if (code === 5)  { events.push({ type: "ctrl-e" }); i++; continue; }
    if (code === 6)  { events.push({ type: "ctrl-f" }); i++; continue; }
    if (code === 11) { events.push({ type: "ctrl-k" }); i++; continue; }
    if (code === 12) { events.push({ type: "ctrl-l" }); i++; continue; }
    if (code === 14) { events.push({ type: "ctrl-n" }); i++; continue; }
    if (code === 15) { events.push({ type: "ctrl-o" }); i++; continue; }
    if (code === 16) { events.push({ type: "ctrl-p" }); i++; continue; }
    if (code === 17) { events.push({ type: "ctrl-q" }); i++; continue; }
    if (code === 18) { events.push({ type: "ctrl-r" }); i++; continue; }
    if (code === 19) { events.push({ type: "ctrl-s" }); i++; continue; }
    if (code === 21) { events.push({ type: "ctrl-u" }); i++; continue; }
    if (code === 22) { events.push({ type: "ctrl-v" }); i++; continue; }
    if (code === 23) { events.push({ type: "ctrl-w" }); i++; continue; }
    if (code === 25) { events.push({ type: "ctrl-y" }); i++; continue; }
    // Ctrl+J (LF) — distinct from Enter
    if (code === 10) { events.push({ type: "ctrl-j" }); i++; continue; }
    // Enter (CR)
    if (code === 13) { events.push({ type: "enter" }); i++; continue; }
    // Backspace
    if (code === 127 || code === 8) { events.push({ type: "backspace" }); i++; continue; }
    // Escape sequences
    if (code === 27) {
      // Bare escape
      if (i + 1 >= str.length) { events.push({ type: "escape" }); i++; continue; }
      if (str[i + 1] === "[") {
        // SGR mouse: ESC [ < Pb ; Px ; Py M  (press) or  ESC [ < Pb ; Px ; Py m  (release)
        if (str[i + 2] === "<") {
          const mEnd = str.indexOf("M", i + 3);
          const mEndR = str.indexOf("m", i + 3);
          // Pick whichever comes first (M=press, m=release)
          let endPos = -1;
          let isRelease = false;
          if (mEnd !== -1 && (mEndR === -1 || mEnd < mEndR)) { endPos = mEnd; isRelease = false; }
          else if (mEndR !== -1) { endPos = mEndR; isRelease = true; }
          if (endPos !== -1) {
            const parts = str.slice(i + 3, endPos).split(";");
            if (parts.length === 3) {
              const cb = parseInt(parts[0], 10);
              const cx = parseInt(parts[1], 10);
              const cy = parseInt(parts[2], 10);
              const isMotion = !!(cb & 32);
              const button = cb & SGR_BUTTON_MASK;
              events.push({
                type: "mouse",
                button,
                col: cx,
                row: cy,
                action: isRelease ? "release" : isMotion ? "motion" : "press",
                shift: !!(cb & 4),
                meta: !!(cb & 8),
                ctrl: !!(cb & 16),
              });
              i = endPos + 1;
              continue;
            }
          }
        }

        // Parse full CSI sequence: ESC [ <params> <final byte>
        // Find the end of the sequence (final byte is 0x40-0x7E)
        let j = i + 2;
        while (j < str.length && (str.charCodeAt(j) < 0x40 || str.charCodeAt(j) > 0x7E)) j++;
        if (j < str.length) {
          const params = str.slice(i + 2, j);
          const final = str[j];
          const seqLen = j - i + 1;

          // CSI u (kitty/st extended keys): ESC [ <keycode> ; <modifiers> u
          // Keycodes are lowercase codepoints. Shift is in the modifier bits.
          if (final === "u") {
            const csiuType = CSI_U_MAP[params];
            if (csiuType) { events.push({ type: csiuType }); i += seqLen; continue; }
            // Unknown CSI u — skip
            i += seqLen;
            continue;
          }

          // Standard CSI sequences
          if (params === "" && final === "A") { events.push({ type: "up" }); i += seqLen; continue; }
          if (params === "" && final === "B") { events.push({ type: "down" }); i += seqLen; continue; }
          if (params === "" && final === "C") { events.push({ type: "right" }); i += seqLen; continue; }
          if (params === "" && final === "D") { events.push({ type: "left" }); i += seqLen; continue; }
          if (params === "" && final === "H") { events.push({ type: "home" }); i += seqLen; continue; }
          if (params === "" && final === "F") { events.push({ type: "end" }); i += seqLen; continue; }
          if (params === "" && final === "Z") { events.push({ type: "backtab" }); i += seqLen; continue; }
          if (params === "3" && final === "~") { events.push({ type: "delete" }); i += seqLen; continue; }
          if (params === "1" && final === "~") { events.push({ type: "home" }); i += seqLen; continue; }
          if (params === "4" && final === "~") { events.push({ type: "end" }); i += seqLen; continue; }

          // Function keys F14-F16: CSI 1;2Q/R/S (Shift+F1/F2/F3 — st maps Ctrl+1/2/3)
          if (params === "1;2" && final === "Q") { events.push({ type: "f14" }); i += seqLen; continue; }
          if (params === "1;2" && final === "R") { events.push({ type: "f15" }); i += seqLen; continue; }
          if (params === "1;2" && final === "S") { events.push({ type: "f16" }); i += seqLen; continue; }

          // Function keys F17-F24: CSI NN;2~ (st maps Ctrl+4 through Ctrl+-)
          if (params === "15;2" && final === "~") { events.push({ type: "f17" }); i += seqLen; continue; }
          if (params === "17;2" && final === "~") { events.push({ type: "f18" }); i += seqLen; continue; }
          if (params === "18;2" && final === "~") { events.push({ type: "f19" }); i += seqLen; continue; }
          if (params === "19;2" && final === "~") { events.push({ type: "f20" }); i += seqLen; continue; }
          if (params === "20;2" && final === "~") { events.push({ type: "f21" }); i += seqLen; continue; }
          if (params === "21;2" && final === "~") { events.push({ type: "f22" }); i += seqLen; continue; }
          if (params === "23;2" && final === "~") { events.push({ type: "f23" }); i += seqLen; continue; }
          if (params === "24;2" && final === "~") { events.push({ type: "f24" }); i += seqLen; continue; }

          // Unknown CSI — skip the full sequence
          i += seqLen;
          continue;
        }
      }
      events.push({ type: "escape" });
      i++;
      continue;
    }
    // Regular character
    if (code >= 32) {
      events.push({ type: "char", char: ch });
      i++;
      continue;
    }
    // Unknown control character
    events.push({ type: "unknown" });
    i++;
  }

  return events;
}
