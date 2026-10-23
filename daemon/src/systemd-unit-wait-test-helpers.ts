import type { CommandOutput } from "./systemd-unit-wait";

/** A scripted user manager: `show` answers with the current properties, `journal` with JSON lines. */
export function fakeSystemd(initial: Record<string, string>) {
  const fake = {
    props: { ...initial } as Record<string, string>,
    journal: [] as Record<string, unknown>[],
    calls: [] as Array<{ command: string; args: string[] }>,
    failShow: 0,
    async run(command: "systemctl" | "journalctl", args: string[]): Promise<CommandOutput> {
      fake.calls.push({ command, args });
      if (command === "journalctl") return { stdout: fake.journal.map(record => JSON.stringify(record)).join("\n"), stderr: "", code: 0 };
      if (fake.failShow > 0) {
        fake.failShow--;
        return { stdout: "", stderr: "Failed to connect to bus", code: 1 };
      }
      return { stdout: Object.entries(fake.props).map(([key, value]) => `${key}=${value}`).join("\n"), stderr: "", code: 0 };
    },
  };
  return fake;
}

export const RUNNING_UNIT = {
  Id: "job.service", LoadState: "loaded", ActiveState: "active", SubState: "running",
  Result: "success", ExecMainCode: "0", ExecMainStatus: "0", InactiveEnterTimestamp: "", InvocationID: "inv1",
};
/** What a `--collect` unit looks like once it stopped and was unloaded. */
export const COLLECTED_UNIT = {
  Id: "job.service", LoadState: "not-found", ActiveState: "inactive", SubState: "dead",
  Result: "success", ExecMainCode: "0", ExecMainStatus: "0", InactiveEnterTimestamp: "", InvocationID: "",
};
