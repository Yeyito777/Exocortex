/**
 * System clipboard access.
 *
 * Detects available clipboard tools and provides copy/paste.
 * Uses pbcopy/pbpaste, xclip, xsel, or wl-copy/wl-paste depending
 * on what's available. Copy is fire-and-forget (async but not awaited).
 */

type ClipboardBackend = "pbcopy" | "xclip" | "xsel" | "wl" | null;

interface TextClipboardSystem {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  commandExists: (command: string) => boolean;
  copy: (command: string[], text: string) => Promise<number>;
  paste: (command: string[]) => Promise<{ output: string; exitCode: number }>;
}

const defaultClipboardSystem: TextClipboardSystem = {
  platform: process.platform,
  env: process.env,
  commandExists: (command) => {
    try {
      return Bun.spawnSync(["which", command], { stderr: "ignore" }).exitCode === 0;
    } catch {
      return false;
    }
  },
  copy: (command, text) => {
    const proc = Bun.spawn(command, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    proc.stdin.write(text);
    proc.stdin.end();
    return proc.exited;
  },
  paste: async (command) => {
    const proc = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" });
    const [output, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return { output, exitCode };
  },
};

let clipboardSystem: TextClipboardSystem = defaultClipboardSystem;

const TEXT_TARGETS = ["UTF8_STRING", "text/plain;charset=utf-8", "text/plain", "STRING", "TEXT"];

let backend: ClipboardBackend | undefined;
let backendEnvKey: string | undefined;
let inMemoryClipboard = "";

export function setTextClipboardSystemForTest(overrides: Partial<TextClipboardSystem> | null): void {
  clipboardSystem = overrides ? { ...defaultClipboardSystem, ...overrides } : defaultClipboardSystem;
  backend = undefined;
  backendEnvKey = undefined;
  inMemoryClipboard = "";
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

function currentBackendEnvKey(): string {
  return `${clipboardSystem.platform}\0${clipboardSystem.env.WAYLAND_DISPLAY ?? ""}\0${clipboardSystem.env.DISPLAY ?? ""}`;
}

function detectBackend(): ClipboardBackend {
  const envKey = currentBackendEnvKey();
  if (backend !== undefined && backendEnvKey === envKey) return backend;

  backendEnvKey = envKey;

  // macOS ships dedicated text pasteboard utilities. This must be checked
  // before the DISPLAY guard below: native macOS terminals do not use X11.
  if (clipboardSystem.platform === "darwin") {
    try {
      if (clipboardSystem.commandExists("pbcopy") && clipboardSystem.commandExists("pbpaste")) {
        backend = "pbcopy";
        return backend;
      }
    } catch { /* pbcopy / pbpaste not available */ }
  }

  // Check for Wayland first.
  if (clipboardSystem.env.WAYLAND_DISPLAY) {
    try {
      if (clipboardSystem.commandExists("wl-copy") && clipboardSystem.commandExists("wl-paste")) {
        backend = "wl";
        return backend;
      }
    } catch { /* wl-copy / wl-paste not available */ }
  }

  // X11 clipboard tools require a display; over plain SSH this is usually unset.
  if (!clipboardSystem.env.DISPLAY) {
    backend = null;
    return backend;
  }

  try {
    if (clipboardSystem.commandExists("xclip")) { backend = "xclip"; return backend; }
  } catch { /* xclip not available */ }

  try {
    if (clipboardSystem.commandExists("xsel")) { backend = "xsel"; return backend; }
  } catch { /* xsel not available */ }

  backend = null;
  return backend;
}

function disableBackend(): void {
  backend = null;
  backendEnvKey = currentBackendEnvKey();
}

function fallbackClipboard(): string {
  return inMemoryClipboard;
}

/** Copy text to the system clipboard. Fire-and-forget. */
export function copyToClipboard(text: string): void {
  inMemoryClipboard = text;

  const be = detectBackend();
  if (!be) return;

  try {
    let cmd: string[];
    switch (be) {
      case "pbcopy": cmd = ["pbcopy"]; break;
      case "xclip":  cmd = ["xclip", "-selection", "clipboard"]; break;
      case "xsel":   cmd = ["xsel", "--clipboard", "--input"]; break;
      case "wl":     cmd = ["wl-copy"]; break;
    }

    clipboardSystem.copy(cmd, text).then((exitCode) => {
      if (exitCode !== 0) disableBackend();
    }).catch(() => disableBackend());
  } catch {
    disableBackend();
  }
}

/** Read text from the system clipboard. */
export async function pasteFromClipboard(): Promise<string> {
  const be = detectBackend();
  if (!be) return fallbackClipboard();

  try {
    let cmd: string[];
    switch (be) {
      case "pbcopy":
        cmd = ["pbpaste"];
        break;
      case "xclip": {
        const targets = await clipboardSystem.paste(["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"]);
        if (targets.exitCode !== 0) return fallbackClipboard();
        const target = pickTextTarget(targets.output);
        if (!target) return fallbackClipboard();
        cmd = ["xclip", "-selection", "clipboard", "-t", target, "-o"];
        break;
      }
      case "xsel":
        cmd = ["xsel", "--clipboard", "--output"];
        break;
      case "wl": {
        const targets = await clipboardSystem.paste(["wl-paste", "--list-types"]);
        if (targets.exitCode !== 0) return fallbackClipboard();
        const target = pickTextTarget(targets.output);
        if (!target) return fallbackClipboard();
        cmd = ["wl-paste", "--no-newline", "--type", target];
        break;
      }
    }

    const { output, exitCode } = await clipboardSystem.paste(cmd);
    return exitCode === 0 ? output : fallbackClipboard();
  } catch {
    disableBackend();
    return fallbackClipboard();
  }
}
