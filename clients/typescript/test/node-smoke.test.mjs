// The client on Node (type stripping, Node 22.18+): one run with an app tool, one conversation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "../src/index.ts";

test("node: run with an app tool and a conversation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exo-client-node-"));
  const socket = join(dir, "d.sock");
  const daemon = spawn("bun", [join(import.meta.dirname, "../../testing/fake-daemon.ts"), "--socket", socket], { stdio: ["pipe", "pipe", "inherit"] });
  try {
    await new Promise((done, fail) => {
      daemon.stdout.on("data", data => String(data).startsWith("ready") && done());
      daemon.once("exit", code => fail(new Error(`fake daemon exited ${code}`)));
      setTimeout(() => fail(new Error("fake daemon did not start")), 5000).unref();
    });
    const client = await connect({ app: "node-smoke", socket });
    try {
      const tool = { name: "lookup", description: "Look up.", inputSchema: { type: "object" }, handler: input => `found ${input.word}` };
      assert.equal((await client.run('tool lookup {"word":"x"}', { tools: { app: [tool] } })).text, "lookup -> found x");
      const conv = await client.conversation({ lifetime: "temporary" });
      let text = "";
      for await (const piece of conv.stream("hi").text()) text += piece;
      assert.equal(text, "echo: hi");
    } finally { client.close(); }
  } finally {
    daemon.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
});
