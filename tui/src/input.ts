/**
 * Terminal key input parser.
 *
 * Converts raw stdin bytes into structured key events.
 */

export interface KeyEvent {
  type: "char" | "enter" | "backspace" | "delete"
      | "left" | "right" | "home" | "end"
      | "up" | "down"
      | "ctrl-c" | "ctrl-d" | "ctrl-l" | "escape"
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

    // Ctrl+C
    if (code === 3) { events.push({ type: "ctrl-c" }); i++; continue; }
    // Ctrl+D
    if (code === 4) { events.push({ type: "ctrl-d" }); i++; continue; }
    // Ctrl+L (newline in input)
    if (code === 12) { events.push({ type: "ctrl-l" }); i++; continue; }
    // Enter
    if (code === 13 || code === 10) { events.push({ type: "enter" }); i++; continue; }
    // Backspace
    if (code === 127 || code === 8) { events.push({ type: "backspace" }); i++; continue; }
    // Escape sequences
    if (code === 27) {
      // Bare escape
      if (i + 1 >= str.length) { events.push({ type: "escape" }); i++; continue; }
      if (str[i + 1] === "[") {
        const seq = str.slice(i + 2, i + 6);
        if (seq[0] === "A") { events.push({ type: "up" }); i += 3; continue; }
        if (seq[0] === "B") { events.push({ type: "down" }); i += 3; continue; }
        if (seq[0] === "C") { events.push({ type: "right" }); i += 3; continue; }
        if (seq[0] === "D") { events.push({ type: "left" }); i += 3; continue; }
        if (seq[0] === "H") { events.push({ type: "home" }); i += 3; continue; }
        if (seq[0] === "F") { events.push({ type: "end" }); i += 3; continue; }
        if (seq.startsWith("3~")) { events.push({ type: "delete" }); i += 4; continue; }
        if (seq.startsWith("1~")) { events.push({ type: "home" }); i += 4; continue; }
        if (seq.startsWith("4~")) { events.push({ type: "end" }); i += 4; continue; }
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
