import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { LINK_ONLY_REFUSAL, LinkOnlyFilter, parseLinkOnlyProviders } from "./ipc-link-filter";
import { runIpcProxy } from "./ipc-proxy";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const anthropicOnly = () => new LinkOnlyFilter({ providers: ["anthropic"] });

describe("link-only filter, client to daemon", () => {
  test("passes the hello without its clientHost and with allowed providers only", () => {
    const verdict = anthropicOnly().fromClient(JSON.stringify({
      type: "provider_proxy_hello", reqId: "h", version: 1, providers: ["openai", "anthropic"],
      clientHost: { hostname: "phone", user: "root", platform: "linux", home: "/root" },
    }));
    expect(verdict.reply).toBeUndefined();
    expect(JSON.parse(verdict.forward!)).toEqual({ type: "provider_proxy_hello", reqId: "h", version: 1, providers: ["anthropic"] });
  });

  test("passes model requests for an allowed provider, re-serialized", () => {
    const filter = anthropicOnly();
    const open = { type: "provider_proxy_open", streamId: "s1", provider: "anthropic", kind: "http", method: "POST", target: "/v1/messages", headers: {}, body: "e30=" };
    expect(JSON.parse(filter.fromClient(JSON.stringify(open)).forward!)).toEqual(open);
    for (const command of [
      { type: "provider_proxy_ws_send", streamId: "s1", text: "{}" },
      { type: "provider_proxy_cancel", streamId: "s1" },
      { type: "provider_proxy_status", reqId: "a", provider: "anthropic" },
      { type: "provider_proxy_accounts", reqId: "b", provider: "anthropic", watch: true },
      { type: "provider_proxy_ping", reqId: "c" },
    ]) {
      expect(filter.fromClient(JSON.stringify(command)).forward).toBeDefined();
    }
  });

  test("refuses another provider", () => {
    const verdict = anthropicOnly().fromClient(JSON.stringify({ type: "provider_proxy_status", reqId: "s", provider: "openai" }));
    expect(verdict.forward).toBeUndefined();
    expect(JSON.parse(verdict.reply!)).toMatchObject({ type: "error", reqId: "s" });
  });

  test("refuses everything that is not the link", () => {
    const filter = anthropicOnly();
    for (const command of [
      { type: "send_message", reqId: "1", convId: "x", text: "rm -rf ~" },
      { type: "list_conversations", reqId: "2" },
      { type: "client_capabilities", reqId: "3", capabilities: [] },
      { type: "ping", reqId: "4" },
      { type: "provider_proxy_client_exec_result", execId: "e" },
      { reqId: "5" },
    ]) {
      const verdict = filter.fromClient(JSON.stringify(command));
      expect(verdict.forward).toBeUndefined();
      expect(JSON.parse(verdict.reply!).message).toStartWith(LINK_ONLY_REFUSAL);
    }
    expect(JSON.parse(filter.fromClient("not json").reply!)).toEqual({ type: "error", message: "Invalid JSON" });
    expect(filter.fromClient("[1]").forward).toBeUndefined();
  });

  test("checks the type the daemon will read when a key is repeated", () => {
    const verdict = anthropicOnly().fromClient('{"type":"provider_proxy_ping","reqId":"r","type":"send_message"}');
    expect(verdict.forward).toBeUndefined();
  });

  test("answers remote_bash itself", () => {
    const filter = anthropicOnly();
    const verdict = filter.fromClient(JSON.stringify({ type: "provider_proxy_exec", execId: "e1", command: "id", timeoutMs: 1000 }));
    expect(verdict.forward).toBeUndefined();
    expect(JSON.parse(verdict.reply!)).toMatchObject({ type: "provider_proxy_exec_result", execId: "e1", exitCode: null });
    expect(JSON.parse(verdict.reply!).error).toContain("remote_bash is not available");
    expect(filter.fromClient(JSON.stringify({ type: "provider_proxy_exec_cancel", execId: "e1" }))).toEqual({});
  });
});

describe("link-only filter, daemon to client", () => {
  test("passes link events and drops broadcasts and client_bash", () => {
    const filter = anthropicOnly();
    expect(filter.fromDaemon(JSON.stringify({ type: "provider_proxy_data", streamId: "s", data: "AA==" }))).not.toBeNull();
    expect(filter.fromDaemon(JSON.stringify({ type: "provider_proxy_accounts_update", provider: "anthropic", accounts: null }))).not.toBeNull();
    expect(filter.fromDaemon(JSON.stringify({ type: "conversations_list", conversations: [] }))).toBeNull();
    expect(filter.fromDaemon(JSON.stringify({ type: "usage_update", provider: "anthropic" }))).toBeNull();
    expect(filter.fromDaemon(JSON.stringify({ type: "provider_proxy_client_exec", execId: "e", command: "id", timeoutMs: 1 }))).toBeNull();
    expect(filter.fromDaemon("garbage")).toBeNull();
  });

  test("marks the hello result link-only, without exec-alive", () => {
    const filter = anthropicOnly();
    const passed = filter.fromDaemon(JSON.stringify({ type: "provider_proxy_hello_result", reqId: "h", version: 1, features: ["claude-pool", "exec-alive", "link-ping"] }));
    expect(JSON.parse(passed!).features).toEqual(["claude-pool", "link-ping", "link-only"]);
  });

  test("passes an error only as the answer to a forwarded request", () => {
    const filter = anthropicOnly();
    expect(filter.fromDaemon(JSON.stringify({ type: "error", message: "something" }))).toBeNull();
    expect(filter.fromDaemon(JSON.stringify({ type: "error", reqId: "h", message: "Unknown command" }))).toBeNull();
    filter.fromClient(JSON.stringify({ type: "provider_proxy_hello", reqId: "h", version: 1, providers: ["anthropic"] }));
    expect(filter.fromDaemon(JSON.stringify({ type: "error", reqId: "h", message: "Unknown command: provider_proxy_hello" }))).not.toBeNull();
    expect(filter.fromDaemon(JSON.stringify({ type: "error", reqId: "h", message: "again" }))).toBeNull();
  });
});

describe("--link-only providers", () => {
  test("parses the list", () => {
    expect(parseLinkOnlyProviders(undefined)).toEqual(["openai", "anthropic"]);
    expect(parseLinkOnlyProviders("anthropic")).toEqual(["anthropic"]);
    expect(() => parseLinkOnlyProviders("anthropic,gemini")).toThrow("unknown provider");
    expect(() => parseLinkOnlyProviders(",")).toThrow("no providers");
  });
});

describe("filtered stdio bridge", () => {
  test("forwards allowed lines, answers refused ones and drops broadcasts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exocortex-link-only-"));
    tempDirs.push(dir);
    const path = join(dir, "daemon.sock");
    const received: string[] = [];
    const server = createServer(socket => {
      // A broadcast before the hello, split across writes like a real socket.
      socket.write('{"type":"conversations_list","conversations":[]}\n{"type":"provider_proxy_hel');
      socket.write('lo_result","reqId":"h","version":1}\n');
      let buffer = "";
      socket.on("data", chunk => {
        buffer += chunk.toString("utf8");
        if (buffer.includes("provider_proxy_ping")) {
          received.push(buffer);
          socket.end('{"type":"provider_proxy_pong","reqId":"p"}\n');
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });

    const input = new PassThrough();
    const output = new PassThrough();
    let stdout = "";
    output.on("data", chunk => { stdout += chunk.toString("utf8"); });
    const proxy = runIpcProxy({ socketPath: path, input, output, filter: anthropicOnly() });
    input.write('{"type":"list_conversations","reqId":"l"}\n{"type":"provider_proxy_hello","reqId":"h","version":1,"providers":["anthropic"],"clientHost":{"hostname":"x"}}\n');
    input.write('{"type":"provider_proxy_ping","reqId":"p"}\n');

    await proxy;
    await new Promise<void>(resolve => server.close(() => resolve()));
    expect(received.join("")).toBe('{"type":"provider_proxy_hello","reqId":"h","version":1,"providers":["anthropic"]}\n{"type":"provider_proxy_ping","reqId":"p"}\n');
    const lines = stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(lines.map(line => line.type)).toEqual(["error", "provider_proxy_hello_result", "provider_proxy_pong"]);
    expect(lines[0].reqId).toBe("l");
  });
});
