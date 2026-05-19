const STARTUP_LAUNCH_ECHOES = [
  "cd ~/Workspace/exocortex && bun run tui/src/main.ts",
  "cd /home/yeyito/Workspace/exocortex && bun run tui/src/main.ts",
  "/home/yeyito/Workspace/exocortex/bin/exocortex",
  "exocortex",
];

function stripOptionalLineEnding(text: string, index: number): string {
  if (text.startsWith("\r\n", index)) return text.slice(index + 2);
  if (text.startsWith("\n", index) || text.startsWith("\r", index)) return text.slice(index + 1);
  return text.slice(index);
}

/**
 * st's persistence layer can inject the terminal launch command into the pty at
 * startup. If the TUI reads that as stdin, it appears as a prefilled prompt.
 * Strip only the known self-launch command when it is the very first input.
 */
export function stripStartupLaunchEcho(text: string): string {
  for (const command of STARTUP_LAUNCH_ECHOES) {
    if (text === command) return "";
    if (text.startsWith(`${command}\n`) || text.startsWith(`${command}\r`)) {
      return stripOptionalLineEnding(text, command.length);
    }
  }
  return text;
}
