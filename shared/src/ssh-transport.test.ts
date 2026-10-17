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
    const command = input.split("\n").slice(0, -1).map(line => JSON.parse(line)).find(line => line.type === "ping");
    if (!command) return;
    input = "";
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
      "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
      "-o", "ControlPath=none",
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

  test("hands over bytes after the pong undecoded so a split character survives", async () => {
    const child = new FakeProcess();
    const event = Buffer.from(`${JSON.stringify({ type: "conversation_updated", title: "🐋" })}\n`);
    const split = event.indexOf(Buffer.from("🐋")) + 2;
    child.stdin.on("data", chunk => {
      const command = JSON.parse(chunk.toString("utf8"));
      child.stdout.write(Buffer.concat([Buffer.from(`${JSON.stringify({ type: "pong", reqId: command.reqId })}\n`), event.subarray(0, split)]));
    });
    const connection = await probeSshProxy("whale", { spawnProcess: () => child }).promise;
    expect(Buffer.concat([connection.bufferedStdout, event.subarray(split)]).toString("utf8"))
      .toBe(event.toString("utf8"));
    child.kill();
  });

  test("writes the preamble ahead of the ping that requests the bootstrap", async () => {
    const child = respondingProbe();
    let input = "";
    child.stdin.on("data", chunk => { input += chunk.toString("utf8"); });
    await probeSshProxy("whale", {
      spawnProcess: () => child,
      preamble: [{ type: "client_capabilities", capabilities: ["token-stats-on-demand"] }],
    }).promise;
    expect(input.split("\n").filter(Boolean).map(line => JSON.parse(line).type)).toEqual(["client_capabilities", "ping"]);
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
