import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  probeSshProxy,
  probeSshProxyWithFallback,
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
    const reuse = sshProxyArgs("whale", { controlPath: "/run/x/ssh/whale%.sock", persist: "10m" });
    expect(reuse).not.toContain("ControlPath=none");
    expect(reuse).toContain("ControlMaster=auto");
    expect(reuse).toContain("ControlPath=/run/x/ssh/whale%%.sock");
    expect(reuse).toContain("ControlPersist=10m");
    expect(reuse.slice(-3)).toEqual(["whale", "exocortexd", "proxy"]);
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

  test("keeps answers that arrive ahead of the pong, in order, for the adopted connection", async () => {
    const child = new FakeProcess();
    let input = "";
    child.stdin.on("data", chunk => {
      input += chunk.toString("utf8");
      const lines = input.split("\n").slice(0, -1).map(line => JSON.parse(line));
      const ping = lines.find(line => line.type === "ping");
      if (!ping) return;
      input = "";
      // The first-flight load is answered before the bootstrap ping.
      child.stdout.write(`${JSON.stringify({ type: "conversation_loaded", reqId: "load-1", entries: [] })}\n`);
      child.stdout.write(`${JSON.stringify({ type: "pong", reqId: ping.reqId })}\n{"type":"tools_available"}\n`);
    });
    const connection = await probeSshProxy("whale", {
      spawnProcess: () => child,
      preamble: [{ type: "client_capabilities", capabilities: [] }, { type: "load_conversation", reqId: "load-1", convId: "c" }],
    }).promise;
    expect(connection.bufferedStdout.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line).type))
      .toEqual(["conversation_loaded", "tools_available"]);
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

  describe("fallback to a fresh connection", () => {
    test("without a pong in time, a fresh probe races the first and the winner is kept", async () => {
      const stuck = new FakeProcess();
      const fresh = respondingProbe();
      let used = 0;
      const connection = await probeSshProxyWithFallback("whale", {
        spawnProcess: () => stuck,
        fallback: primary => primary === stuck ? { afterMs: 5, spawnProcess: () => fresh, onUsed: () => { used++; } } : null,
      }).promise;
      expect(connection.process).toBe(fresh);
      expect(stuck.killed).toBe(true);
      expect(used).toBe(1);
      fresh.kill();
    });

    test("an answer in time never starts the fallback", async () => {
      const healthy = respondingProbe();
      let spawned = 0;
      const connection = await probeSshProxyWithFallback("whale", {
        spawnProcess: () => healthy,
        fallback: () => ({ afterMs: 1_000, spawnProcess: () => { spawned++; return new FakeProcess(); } }),
      }).promise;
      expect(connection.process).toBe(healthy);
      expect(spawned).toBe(0);
      healthy.kill();
    });

    test("a first probe that fails starts the fallback at once; both failing reports the fresh one's error", async () => {
      const broken = new FakeProcess();
      const alsoBroken = new FakeProcess();
      const probe = probeSshProxyWithFallback("whale", {
        spawnProcess: () => broken,
        fallback: () => ({ afterMs: 60_000, spawnProcess: () => alsoBroken }),
      });
      broken.emit("close", 255, null);
      await Bun.sleep(1);
      alsoBroken.stderr.write("Could not resolve hostname whale");
      alsoBroken.emit("close", 255, null);
      await expect(probe.promise).rejects.toThrow("Could not resolve hostname whale");
    });

    test("no fallback for a connection that didn't ride an existing master", async () => {
      const healthy = respondingProbe();
      const connection = await probeSshProxyWithFallback("whale", { spawnProcess: () => healthy, fallback: () => null }).promise;
      expect(connection.process).toBe(healthy);
      healthy.kill();
    });

    test("cancelling stops both probes", async () => {
      const first = new FakeProcess();
      const second = new FakeProcess();
      const probe = probeSshProxyWithFallback("whale", {
        spawnProcess: () => first,
        fallback: () => ({ afterMs: 1, spawnProcess: () => second }),
      });
      await Bun.sleep(5);
      probe.cancel("switch cancelled");
      await expect(probe.promise).rejects.toThrow();
      expect(first.killed).toBe(true);
      expect(second.killed).toBe(true);
    });
  });
});
