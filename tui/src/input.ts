/**
 * Terminal key input parser.
 *
 * Converts raw stdin bytes into structured key events.
 */

export interface KeyEvent {
  type: "char" | "enter" | "tab" | "backtab" | "backspace" | "delete"
      | "left" | "right" | "home" | "end"
      | "up" | "down"
      | "ctrl-b" | "ctrl-c" | "ctrl-d" | "ctrl-e" | "ctrl-f"
      | "ctrl-j" | "ctrl-k" | "ctrl-l" | "ctrl-m" | "ctrl-n"
      | "ctrl-o" | "ctrl-q" | "ctrl-r" | "ctrl-u" | "ctrl-v" | "ctrl-w" | "ctrl-y"
      | "ctrl-shift-o"
      | "f14" | "f15" | "f16" | "f17" | "f18" | "f19"
      | "f20" | "f21" | "f22" | "f23" | "f24"
      | "escape"
      | "paste"
      | "unknown";
  char?: string;
  /** For paste events: the full pasted text. */
  text?: string;
}

/**
 * CSI u (kitty keyboard protocol) lookup table.
 * Key: the params portion of ESC [ <params> u  (e.g. "109;5")
 * Value: the KeyEvent type it maps to.
 * Codepoints are always lowercase. Shift is in the modifier bits (1-based: 2=shift, 5=ctrl, 6=ctrl+shift).
 */
const CSI_U_MAP: Record<string, KeyEvent["type"]> = {
  "109;5": "ctrl-m",         // Ctrl+M (m=109)
  "111;6": "ctrl-shift-o",   // Ctrl+Shift+O (o=111)
};

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export function parseKeys(data: Buffer): KeyEvent[] {
  const events: KeyEvent[] = [];
  const str = data.toString("utf-8");
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
    if (code === 17) { events.push({ type: "ctrl-q" }); i++; continue; }
    if (code === 18) { events.push({ type: "ctrl-r" }); i++; continue; }
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
