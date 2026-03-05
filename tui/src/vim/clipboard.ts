/**
 * System clipboard access.
 *
 * Detects available clipboard tools and provides copy/paste.
 * Uses xclip, xsel, or wl-copy/wl-paste depending on what's
 * available. Copy is fire-and-forget (async but not awaited).
 */

type ClipboardBackend = "xclip" | "xsel" | "wl" | null;

let backend: ClipboardBackend | undefined;

function detectBackend(): ClipboardBackend {
  if (backend !== undefined) return backend;

  // Check for Wayland first
  if (process.env.WAYLAND_DISPLAY) {
    try {
      Bun.spawnSync(["which", "wl-copy"]);
      backend = "wl";
      return backend;
    } catch {}
  }

  // X11
  try {
    const r = Bun.spawnSync(["which", "xclip"]);
    if (r.exitCode === 0) { backend = "xclip"; return backend; }
  } catch {}

  try {
    const r = Bun.spawnSync(["which", "xsel"]);
    if (r.exitCode === 0) { backend = "xsel"; return backend; }
  } catch {}

  backend = null;
  return backend;
}

/** Copy text to the system clipboard. Fire-and-forget. */
export function copyToClipboard(text: string): void {
  const be = detectBackend();
  if (!be) return;

  try {
    let cmd: string[];
    switch (be) {
      case "xclip":  cmd = ["xclip", "-selection", "clipboard"]; break;
      case "xsel":   cmd = ["xsel", "--clipboard", "--input"]; break;
      case "wl":     cmd = ["wl-copy"]; break;
    }

    const proc = Bun.spawn(cmd, { stdin: "pipe" });
    proc.stdin.write(text);
    proc.stdin.end();
  } catch {
    // Silently fail — clipboard is best-effort
  }
}

/** Read text from the system clipboard. */
export async function pasteFromClipboard(): Promise<string> {
  const be = detectBackend();
  if (!be) return "";

  try {
    let cmd: string[];
    switch (be) {
      case "xclip":  cmd = ["xclip", "-selection", "clipboard", "-o"]; break;
      case "xsel":   cmd = ["xsel", "--clipboard", "--output"]; break;
      case "wl":     cmd = ["wl-paste", "--no-newline"]; break;
    }

    const proc = Bun.spawn(cmd, { stdout: "pipe" });
    const output = await new Response(proc.stdout).text();
    return output;
  } catch {
    return "";
  }
}
