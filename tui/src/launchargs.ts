import { validateSshAlias } from "./ssh-transport";

export interface TuiLaunchOptions {
  sshAlias: string | null;
  profileStartup: boolean;
  showHelp: boolean;
}

export const TUI_USAGE = [
  "Usage: exocortex [options]",
  "",
  "Options:",
  "  --ssh <alias>  Connect through this SSH alias on launch",
  "  -h, --help     Show this help",
].join("\n");

export function parseTuiLaunchArgs(args: readonly string[]): TuiLaunchOptions {
  const options: TuiLaunchOptions = {
    sshAlias: null,
    profileStartup: false,
    showHelp: false,
  };

  const setSshAlias = (alias: string | undefined): void => {
    if (!alias || alias.startsWith("-")) {
      throw new Error("--ssh requires an SSH alias.");
    }
    if (options.sshAlias !== null) {
      throw new Error("--ssh may only be specified once.");
    }
    const validationError = validateSshAlias(alias);
    if (validationError) throw new Error(`Invalid --ssh alias: ${validationError}`);
    options.sshAlias = alias;
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--ssh") {
      setSshAlias(args[index + 1]);
      index += 1;
    } else if (arg.startsWith("--ssh=")) {
      setSshAlias(arg.slice("--ssh=".length));
    } else if (arg === "--profile-startup") {
      // Internal profiling option retained for scripts/dev/profile-startup.
      options.profileStartup = true;
    } else if (arg === "--help" || arg === "-h") {
      options.showHelp = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

interface StartupSshClient {
  ssh(action: "connect", alias: string): void;
}

/** Apply route options only after the local TUI session is fully initialized. */
export function applyTuiLaunchOptions(options: TuiLaunchOptions, daemon: StartupSshClient): void {
  if (options.sshAlias) daemon.ssh("connect", options.sshAlias);
}
