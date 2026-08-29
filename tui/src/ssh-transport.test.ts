import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  probeSshProxy,
  sshProxyArgs,
  validateSshAlias,
  type SshProcess,
} from "./ssh-transport";

class FakeProcess extends EventEmitter implements SshProcess {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    queueMicrotask(() => this.emit("close", 0, null));
    return true;
  }
}

function respondingProbe(): FakeProcess {
  const child = new FakeProcess();
  let input = "";
  child.stdin.on("data", chunk => {
    input += chunk.toString("utf8");
    const newline = input.indexOf("\n");
    if (newline === -1) return;
    const command = JSON.parse(input.slice(0, newline));
    child.stdout.write(`${JSON.stringify({ type: "pong", reqId: command.reqId })}\n`);
  });
  return child;
}

describe("TUI SSH transport", () => {
  test("validates aliases and keeps the destination in one ssh argv", () => {
    expect(validateSshAlias("whale-dev_2.example")).toBeNull();
    expect(validateSshAlias("-oProxyCommand=oops")).not.toBeNull();
    expect(validateSshAlias("host name")).not.toBeNull();
    expect(validateSshAlias("user@host")).not.toBeNull();
    expect(sshProxyArgs("whale")).toEqual([
      "-T", "-C", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
      "whale", "exocortexd", "proxy",
    ]);
  });

  test("transfers the successful probe process instead of killing it", async () => {
    const child = respondingProbe();
    const connection = await probeSshProxy("whale", { spawnProcess: () => child }).promise;
    expect(connection.process).toBe(child);
    expect(child.killed).toBe(false);
    child.kill();
  });

  test("reports proxy stderr when the remote daemon cannot be reached", async () => {
    const child = new FakeProcess();
    const probe = probeSshProxy("missing", { spawnProcess: () => child });
    child.stderr.write("Permission denied");
    child.emit("close", 255, null);

    await expect(probe.promise).rejects.toThrow("Permission denied");
  });

  test("cancels an in-flight probe", async () => {
    const child = new FakeProcess();
    const probe = probeSshProxy("slowbox", { spawnProcess: () => child });
    probe.cancel("switch cancelled");

    await expect(probe.promise).rejects.toThrow("switch cancelled");
    expect(child.killed).toBe(true);
  });
});
