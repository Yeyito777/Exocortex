/**
 * System clipboard access.
 *
 * Detects available clipboard tools and provides copy/paste.
 * Uses xclip, xsel, or wl-copy/wl-paste depending on what's
 * available. Copy is fire-and-forget (async but not awaited).
 */

type ClipboardBackend = "xclip" | "xsel" | "wl" | null;

const TEXT_TARGETS = ["UTF8_STRING", "text/plain;charset=utf-8", "text/plain", "STRING", "TEXT"];

let backend: ClipboardBackend | undefined;

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function pickTextTarget(availableTargets: string): string | null {
  const available = new Set(
    availableTargets
      .split(/\r?\n/)
      .map((target) => target.trim())
      .filter(Boolean),
  );
  return TEXT_TARGETS.find((target) => available.has(target)) ?? null;
}

function detectBackend(): ClipboardBackend {
  if (backend !== undefined) return backend;

  // Check for Wayland first
  if (process.env.WAYLAND_DISPLAY) {
    try {
      const copy = Bun.spawnSync(["which", "wl-copy"]);
      const paste = Bun.spawnSync(["which", "wl-paste"]);
      if (copy.exitCode === 0 && paste.exitCode === 0) {
        backend = "wl";
        return backend;
      }
    } catch { /* wl-copy / wl-paste not available */ }
  }

  // X11
  try {
    const r = Bun.spawnSync(["which", "xclip"]);
    if (r.exitCode === 0) { backend = "xclip"; return backend; }
  } catch { /* xclip not available */ }

  try {
    const r = Bun.spawnSync(["which", "xsel"]);
    if (r.exitCode === 0) { backend = "xsel"; return backend; }
  } catch { /* xsel not available */ }

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
      case "xclip": {
        const targets = Bun.spawnSync(["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"]);
        if (targets.exitCode !== 0) return "";
        const target = pickTextTarget(decodeText(targets.stdout));
        if (!target) return "";
        cmd = ["xclip", "-selection", "clipboard", "-t", target, "-o"];
        break;
      }
      case "xsel":
        cmd = ["xsel", "--clipboard", "--output"];
        break;
      case "wl": {
        const targets = Bun.spawnSync(["wl-paste", "--list-types"]);
        if (targets.exitCode !== 0) return "";
        const target = pickTextTarget(decodeText(targets.stdout));
        if (!target) return "";
        cmd = ["wl-paste", "--no-newline", "--type", target];
        break;
      }
    }

    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const [output, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return exitCode === 0 ? output : "";
  } catch {
    return "";
  }
}
