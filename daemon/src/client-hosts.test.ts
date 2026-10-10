import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ClientHostInfo, Event } from "@exocortex/shared/protocol";
import {
  CLIENT_HOST_NOTICE_KIND, attachClientHost, attachedClientHost, clientHostNotice, resetClientHostsForTest,
  runOnClientHost, settleClientExec,
} from "./client-hosts";
import { createModelVisibleSystemNotice, type Conversation } from "./messages";
import type { ConnectedClient } from "./server";
import { getRegisteredTools } from "./tools/registry";

// Through the registry: client-bash → conversations → registry would otherwise
// reach the registry before client_bash is defined.
const clientBash = getRegisteredTools().find(tool => tool.name === "client_bash")!;
const laptop: ClientHostInfo = { hostname: "toronto", user: "yeyito", platform: "linux", home: "/home/yeyito" };

function fakeClient(subscriptions: string[] = []): { client: ConnectedClient; sent: Event[]; close(): void } {
  const socket = Object.assign(new EventEmitter(), { destroyed: false });
  const client = { id: "c", socket, subscriptions: new Set(subscriptions), buffer: "", capabilities: new Set() } as unknown as ConnectedClient;
  const sent: Event[] = [];
  return {
    client,
    sent,
    close() {
      socket.destroyed = true;
      socket.emit("close");
    },
  };
}

function attach(info: ClientHostInfo = laptop, subscriptions: string[] = []) {
  const fake = fakeClient(subscriptions);
  attachClientHost(fake.client, info, event => fake.sent.push(event));
  return fake;
}

function lastRequest(sent: Event[]) {
  const request = sent.findLast(event => event.type === "client_exec_request");
  if (request?.type !== "client_exec_request") throw new Error("no client_exec_request sent");
  return request;
}

function conversation(messages: Conversation["messages"] = [], subagent = false): Pick<Conversation, "id" | "messages" | "subagentPolicy"> {
  return {
    id: "conv-1",
    messages,
    subagentPolicy: subagent ? { parentConversationId: "parent", allowEdits: false, parentSystemInstructions: "" } : null,
  };
}

afterEach(() => resetClientHostsForTest());

describe("client hosts", () => {
  test("fails immediately when no SSH client is attached", async () => {
    const outcome = await runOnClientHost("conv-1", { command: "ls", timeoutMs: 1_000 });
    expect(outcome).toEqual({ failure: expect.stringContaining("No SSH client is connected") });
  });

  test("ignores announcements without a usable host", () => {
    const fake = fakeClient();
    attachClientHost(fake.client, { hostname: "" }, () => {});
    attachClientHost(fake.client, null, () => {});
    expect(attachedClientHost()).toBeNull();
  });

  test("sends the request to the attached client and resolves with its result", async () => {
    const { client, sent } = attach();
    const running = runOnClientHost("conv-1", { command: "uname -a", cwd: "~/src", timeoutMs: 5_000 });
    const request = lastRequest(sent);
    expect(request).toMatchObject({ command: "uname -a", cwd: "~/src", timeoutMs: 5_000 });

    // Answers from another connection are not trusted.
    settleClientExec(fakeClient().client, { type: "client_exec_result", execId: request.execId, output: "forged", byteTruncated: false, exitCode: 0, signal: null, timedOut: false });
    settleClientExec(client, { type: "client_exec_result", execId: request.execId, output: "Linux toronto\n", byteTruncated: false, exitCode: 0, signal: null, timedOut: false });
    expect(await running).toEqual({ host: laptop, output: "Linux toronto\n", byteTruncated: false, exitCode: 0, signal: null, timedOut: false });
  });

  test("prefers a client viewing the conversation, then the most recently attached", async () => {
    const viewing = attach({ ...laptop, hostname: "viewing" }, ["conv-1"]);
    await Bun.sleep(2);
    attach({ ...laptop, hostname: "newer" });
    expect(attachedClientHost("conv-1")?.hostname).toBe("viewing");
    expect(attachedClientHost("conv-2")?.hostname).toBe("newer");
    viewing.close();
    expect(attachedClientHost("conv-1")?.hostname).toBe("newer");
  });

  test("a lost connection fails its pending commands and detaches the host", async () => {
    const fake = attach();
    const running = runOnClientHost("conv-1", { command: "sleep 100", timeoutMs: 100_000 });
    fake.close();
    expect(await running).toEqual({ failure: expect.stringContaining("connection to yeyito@toronto was lost") });
    expect(attachedClientHost()).toBeNull();
  });

  test("aborting cancels the command on the client", async () => {
    const { sent } = attach();
    const controller = new AbortController();
    const running = runOnClientHost("conv-1", { command: "sleep 100", timeoutMs: 100_000 }, controller.signal);
    const { execId } = lastRequest(sent);
    controller.abort();
    expect(await running).toEqual({ failure: expect.stringContaining("Interrupted") });
    expect(sent.at(-1)).toEqual({ type: "client_exec_cancel", execId });
  });
});

describe("client host notices", () => {
  const notice = (text: string) => createModelVisibleSystemNotice(text, "model", CLIENT_HOST_NOTICE_KIND, 1);

  test("says nothing to a conversation that was never told and has no client", () => {
    expect(clientHostNotice(conversation())).toBeNull();
  });

  test("announces an attached client once, then its departure once", () => {
    attach();
    const attached = clientHostNotice(conversation());
    expect(attached).toContain("yeyito@toronto (Linux, home /home/yeyito)");
    expect(attached).toContain("client_bash runs commands on that machine");
    expect(clientHostNotice(conversation([notice(attached!)]))).toBeNull();

    resetClientHostsForTest();
    const detached = clientHostNotice(conversation([notice(attached!)]));
    expect(detached).toContain("no longer connected");
    expect(clientHostNotice(conversation([notice(attached!), notice(detached!)]))).toBeNull();
  });

  test("announces a different machine", () => {
    attach();
    const first = clientHostNotice(conversation())!;
    resetClientHostsForTest();
    attach({ ...laptop, hostname: "office", platform: "darwin" });
    expect(clientHostNotice(conversation([notice(first)]))).toContain("yeyito@office (macOS");
  });

  test("never tells subagents", () => {
    attach();
    expect(clientHostNotice(conversation([], true))).toBeNull();
  });
});

describe("client_bash tool", () => {
  async function run(input: Record<string, unknown>, result: Record<string, unknown>) {
    const { client, sent } = attach();
    const running = clientBash.execute(input, { conversationId: "conv-1" });
    await Bun.sleep(0);
    settleClientExec(client, {
      type: "client_exec_result", execId: lastRequest(sent).execId,
      output: "", byteTruncated: false, exitCode: 0, signal: null, timedOut: false, ...result,
    });
    return { result: await running, request: lastRequest(sent) };
  }

  test("returns output and reports failing exit codes", async () => {
    expect((await run({ command: "echo hi" }, { output: "hi\n" })).result).toMatchObject({ output: "hi\n", isError: false, exitCode: 0 });
    expect((await run({ command: "false" }, { exitCode: 1 })).result).toMatchObject({ output: "\n(exit code 1)", isError: true });
  });

  test("passes cwd and timeout, and reports a timeout on the client", async () => {
    const { result, request } = await run({ command: "sleep 9", cwd: "/tmp", timeout_seconds: 2 }, {
      output: "partial", timedOut: true, signal: "SIGTERM", exitCode: null,
    });
    expect(request).toMatchObject({ cwd: "/tmp", timeoutMs: 2_000 });
    expect(result.isError).toBe(true);
    expect(result.output).toBe("Error: command timed out after 2s on yeyito@toronto\npartial");
  });

  test("reports client-side errors", async () => {
    const { result } = await run({ command: "ls", cwd: "/nope" }, { error: "Working directory not found: /nope", exitCode: null });
    expect(result).toMatchObject({ output: "Error on yeyito@toronto: Working directory not found: /nope", isError: true });
  });

  test("errors without a client", async () => {
    const result = await clientBash.execute({ command: "ls" }, { conversationId: "conv-1" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("No SSH client is connected");
  });
});
