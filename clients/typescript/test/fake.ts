/** Spawns clients/testing/fake-daemon.ts on a temporary socket for one test. */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const fakeDaemon = resolve(import.meta.dirname, "../../testing/fake-daemon.ts");

export interface Fake { socket: string; dir: string; stop: () => Promise<void> }

export async function startFake(args: string[] = []): Promise<Fake> {
  const dir = mkdtempSync(join(tmpdir(), "exo-client-"));
  const socket = join(dir, "d.sock");
  const child: ChildProcess = spawn("bun", [fakeDaemon, "--socket", socket, ...args], { stdio: ["pipe", "pipe", "inherit"] });
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error("fake daemon did not start")), 5000);
    child.stdout!.on("data", (data: Buffer) => { if (String(data).startsWith("ready")) { clearTimeout(timer); done(); } });
    child.once("exit", code => { clearTimeout(timer); fail(new Error(`fake daemon exited ${code}`)); });
  });
  return {
    socket, dir,
    stop: async () => {
      if (child.exitCode === null) {
        const exited = new Promise(done => child.once("exit", done));
        child.kill("SIGTERM");
        await exited;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
