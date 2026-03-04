/**
 * Terminal key input parser.
 *
 * Converts raw stdin bytes into structured key events.
 */

export interface KeyEvent {
  type: "char" | "enter" | "backspace" | "delete"
      | "left" | "right" | "home" | "end"
      | "up" | "down"
      | "ctrl-b" | "ctrl-c" | "ctrl-d" | "ctrl-e" | "ctrl-f"
      | "ctrl-j" | "ctrl-k" | "ctrl-l" | "ctrl-m" | "ctrl-n"
      | "ctrl-u" | "ctrl-y"
      | "ctrl-shift-o"
      | "escape"
      | "unknown";
  char?: string;
}

export function parseKeys(data: Buffer): KeyEvent[] {
  const events: KeyEvent[] = [];
  const str = data.toString("utf-8");
  let i = 0;

  while (i < str.length) {
    const ch = str[i];
    const code = str.charCodeAt(i);

    // Ctrl keys (byte order)
    if (code === 2)  { events.push({ type: "ctrl-b" }); i++; continue; }
    if (code === 3)  { events.push({ type: "ctrl-c" }); i++; continue; }
    if (code === 4)  { events.push({ type: "ctrl-d" }); i++; continue; }
    if (code === 5)  { events.push({ type: "ctrl-e" }); i++; continue; }
    if (code === 6)  { events.push({ type: "ctrl-f" }); i++; continue; }
    if (code === 11) { events.push({ type: "ctrl-k" }); i++; continue; }
    if (code === 12) { events.push({ type: "ctrl-l" }); i++; continue; }
    if (code === 14) { events.push({ type: "ctrl-n" }); i++; continue; }
    if (code === 21) { events.push({ type: "ctrl-u" }); i++; continue; }
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
          if (final === "u") {
            const parts = params.split(";");
            const keycode = parseInt(parts[0], 10);
            const mods = parseInt(parts[1] ?? "1", 10);
            const modsDecoded = mods - 1;  // CSI u modifiers are 1-based
            const shift = (modsDecoded & 1) !== 0;
            const ctrl = (modsDecoded & 4) !== 0;
            if (ctrl && !shift && keycode === 109) { events.push({ type: "ctrl-m" }); i += seqLen; continue; }
            if (ctrl && shift && keycode === 79) { events.push({ type: "ctrl-shift-o" }); i += seqLen; continue; }
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
          if (params === "3" && final === "~") { events.push({ type: "delete" }); i += seqLen; continue; }
          if (params === "1" && final === "~") { events.push({ type: "home" }); i += seqLen; continue; }
          if (params === "4" && final === "~") { events.push({ type: "end" }); i += seqLen; continue; }

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
