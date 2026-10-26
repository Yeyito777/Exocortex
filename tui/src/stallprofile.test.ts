import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const STALL_PROFILE = resolve(import.meta.dir, "stallprofile.ts");
const TAP = resolve(import.meta.dir, "../../scripts/dev/readonly-daemon-tap.ts");

describe("stall profiler", () => {
  test("reports a blocking stretch and the labelled span that made it, on exit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stallprofile-"));
    try {
      const script = join(dir, "busy.ts");
      writeFileSync(script, `import { stallSpan, stallMark } from ${JSON.stringify(STALL_PROFILE)};
await Bun.sleep(20);
stallMark("before");
stallSpan("event:busy", () => { const end = performance.now() + 60; while (performance.now() < end) {} });
await Bun.sleep(20);
process.exit(0);
`);
      const out = join(dir, "report.json");
      const child = Bun.spawn(["bun", script], { env: { ...process.env, EXOCORTEX_PROFILE_STALLS: out } });
      expect(await child.exited).toBe(0);
      const report = JSON.parse(readFileSync(out, "utf8"));
      expect(report.spans).toContainEqual(expect.objectContaining({ label: "event:busy", parent: null }));
      const stall = report.stalls.find((s: { ms: number }) => s.ms >= 50);
      expect(stall?.labels.some((label: string) => label.startsWith("event:busy:"))).toBe(true);
      expect(report.marks.map((m: { mark: string }) => m.mark)).toEqual(["before"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is a plain passthrough when off", async () => {
    const { stallSpan, STALL_PROFILE: on } = await import("./stallprofile");
    expect(on).toBe(!!process.env.EXOCORTEX_PROFILE_STALLS);
    expect(stallSpan("x", () => 42)).toBe(42);
  });
});

describe("read-only daemon tap", () => {
  test("forwards only read-only commands, without clientHost, and drops client_exec events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "readonly-tap-"));
    const socketPath = join(dir, "d.sock");
    const received: Array<Record<string, unknown>> = [];
    let resolveSeen!: () => void;
    const seen = new Promise<void>(r => { resolveSeen = r; });
    const server = createServer(connection => {
      let buffer = "";
      connection.on("data", chunk => {
        buffer += chunk.toString();
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const command = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          received.push(command);
          if (command.type === "ping") {
            connection.write(JSON.stringify({ type: "client_exec_request", execId: "x", command: "rm -rf ~" }) + "\n");
            connection.write(JSON.stringify({ type: "pong", reqId: command.reqId }) + "\n");
            resolveSeen();
          }
        }
      });
    });
    await new Promise<void>(r => server.listen(socketPath, r));
    try {
      const tap = Bun.spawn(["bun", TAP], { stdin: "pipe", stdout: "pipe", env: { ...process.env, TAP_SOCKET: socketPath } });
      const lines = [
        { type: "client_capabilities", capabilities: [], clientHost: { hostname: "mac", user: "u", platform: "darwin", home: "/Users/u" } },
        { type: "send_message", convId: "c", text: "hello" },
        { type: "abort", convId: "c" },
        { type: "prewarm_conversation", convId: "c" },
        { type: "client_exec_result", execId: "x", exitCode: 0 },
        { type: "load_conversation", convId: "c", reqId: "r1" },
        { type: "ping", reqId: "p1" },
      ];
      tap.stdin.write(lines.map(line => JSON.stringify(line)).join("\n") + "\n");
      tap.stdin.flush();
      await seen;
      const reader = tap.stdout.getReader();
      const { value } = await reader.read();
      tap.kill();
      expect(received.map(command => command.type)).toEqual(["client_capabilities", "load_conversation", "ping"]);
      expect(received[0]).not.toHaveProperty("clientHost");
      const downstream = new TextDecoder().decode(value);
      expect(downstream).toContain('"pong"');
      expect(downstream).not.toContain("client_exec_request");
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
