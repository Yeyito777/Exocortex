/**
 * Last-resort handling for errors nothing else caught.
 *
 * The TUI draws on the terminal's alternate screen. Left to the runtime, a
 * crash prints its stack there and the exit handler then leaves the alternate
 * screen, wiping it: the TUI just vanishes with no trace (on the Mac over /ssh,
 * nowhere at all). Log the stack, restore the terminal, then print it.
 */

export interface FatalErrorSinks {
  log: (message: string) => void;
  restoreTerminal: () => void;
  writeStderr: (text: string) => void;
  exit: (code: number) => void;
  logPath: string;
}

export function describeFatalError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}

export function handleFatalError(kind: string, error: unknown, sinks: FatalErrorSinks): void {
  const detail = describeFatalError(error);
  try { sinks.log(`tui: fatal ${kind}: ${detail}`); } catch { /* still report it below */ }
  try { sinks.restoreTerminal(); } catch { /* the terminal may already be gone */ }
  try {
    sinks.writeStderr(`\nExocortex TUI crashed (${kind}):\n${detail}\n\nAlso logged to ${sinks.logPath}\n`);
  } catch { /* stderr closed */ }
  sinks.exit(1);
}

export function installFatalErrorHandlers(sinks: FatalErrorSinks): void {
  let handling = false;
  const handle = (kind: string) => (error: unknown) => {
    if (handling) return;
    handling = true;
    handleFatalError(kind, error, sinks);
  };
  process.on("uncaughtException", handle("uncaught exception"));
  process.on("unhandledRejection", handle("unhandled rejection"));
}
