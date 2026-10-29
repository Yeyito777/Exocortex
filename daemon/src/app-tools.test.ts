import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Event } from "./protocol";
import { appToolBroker, appToolCallView, appToolFor, resolveAppBuiltinTools, validateAppToolDefs, type AppToolOwner } from "./app-tools";
import { getConversationToolNames } from "./tools/registry";
import { toolTimeoutReason } from "./abort";
import { registerAppConversation, resetAppRegistryForTests, type AppConversationRecord } from "./app-registry";

const lookup = { name: "lookup", description: "Look a word up.", inputSchema: { type: "object", properties: { word: { type: "string" } } } };

describe("app built-in tool vocabulary", () => {
  test("maps each neutral name to Claude Code's built-ins under anthropic, host tools to Exocortex's", () => {
    expect(resolveAppBuiltinTools(["bash", "read", "write", "edit", "glob", "grep", "web_search", "web_fetch", "exo", "goal", "attach"], "anthropic")).toEqual({
      exocortexTools: ["exo", "goal", "attach"],
      claudeCodeTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch"],
    });
  });

  test("maps to Codex's primitives on openai", () => {
    expect(resolveAppBuiltinTools(["bash", "read", "write", "edit", "glob", "grep", "web_fetch", "chrono"], "openai")).toEqual({
      exocortexTools: ["exec_command", "write_stdin", "read", "view_image", "apply_patch", "glob", "grep", "browse", "chrono"],
    });
  });

  test("maps to Exocortex's own tools on other providers", () => {
    expect(resolveAppBuiltinTools(["bash", "read", "write", "edit", "glob", "grep", "web_fetch"], "deepseek")).toEqual({
      exocortexTools: ["bash", "read", "write", "edit", "glob", "grep", "browse"],
    });
  });

  test("an unknown name, or one the provider cannot offer, is an error naming it", () => {
    expect(() => resolveAppBuiltinTools(["bash", "teleport"], "anthropic")).toThrow(/teleport/);
    expect(() => resolveAppBuiltinTools(["web_search"], "openai")).toThrow(/web_search is not available on openai/);
    expect(() => resolveAppBuiltinTools(["web_search"], "deepseek")).toThrow(/web_search/);
  });

  test("ephemeral conversations cannot take chrono, whose schedules would outlive them", () => {
    expect(() => resolveAppBuiltinTools(["chrono"], "openai", { ephemeral: true })).toThrow(/chrono/);
    expect(resolveAppBuiltinTools("all", "openai", { ephemeral: true }).exocortexTools).not.toContain("chrono");
  });

  test('"all" is what an ordinary conversation gets, with Claude Code keeping its full set', () => {
    expect(resolveAppBuiltinTools("all", "openai")).toEqual({ exocortexTools: getConversationToolNames("openai") });
    expect(resolveAppBuiltinTools("all", "anthropic")).toEqual({ exocortexTools: getConversationToolNames("anthropic") });
    expect(resolveAppBuiltinTools([], "anthropic")).toEqual({ exocortexTools: [], claudeCodeTools: [] });
  });
});

describe("app tool definitions", () => {
  test("normalize to object schemas and keep timeouts", () => {
    expect(validateAppToolDefs([{ ...lookup, inputSchema: { properties: {} }, timeoutMs: 5000 }])).toEqual([
      { name: "lookup", description: "Look a word up.", inputSchema: { type: "object", properties: {} }, timeoutMs: 5000 },
    ]);
    expect(validateAppToolDefs(undefined)).toEqual([]);
  });

  test("refuse bad names, duplicates, built-in names and bad schemas", () => {
    expect(() => validateAppToolDefs([{ ...lookup, name: "has space" }])).toThrow(/name/);
    expect(() => validateAppToolDefs([lookup, lookup])).toThrow(/twice/);
    for (const name of ["bash", "read", "exec_command", "Bash", "TodoWrite", "Task", "web_search", "exo"]) {
      expect(() => validateAppToolDefs([{ ...lookup, name }])).toThrow(/built-in/);
    }
    expect(() => validateAppToolDefs([{ ...lookup, description: " " }])).toThrow(/description/);
    expect(() => validateAppToolDefs([{ ...lookup, inputSchema: { type: "string" } }])).toThrow(/object/);
    expect(() => validateAppToolDefs([{ ...lookup, inputSchema: [] }])).toThrow(/inputSchema/);
    expect(() => validateAppToolDefs([{ ...lookup, timeoutMs: 0 }])).toThrow(/timeoutMs/);
    expect(() => validateAppToolDefs("lookup")).toThrow(/array/);
    expect(() => validateAppToolDefs(Array.from({ length: 129 }, (_, index) => ({ ...lookup, name: `t${index}` })))).toThrow(/at most/);
  });
});

function record(convId: string, overrides: Partial<AppConversationRecord> = {}): AppConversationRecord {
  return {
    convId,
    app: "demo",
    lifetime: "ephemeral",
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    system: { text: "", base: "none" },
    builtin: [],
    appTools: [lookup],
    ...overrides,
  };
}

describe("app tool calls", () => {
  const sent: Array<{ owner: string; event: Event }> = [];
  let owner: AppToolOwner | null = null;

  beforeEach(() => {
    resetAppRegistryForTests();
    sent.length = 0;
    owner = { id: "c1" };
    appToolBroker.configure({ owner: () => owner, send: (to, event) => sent.push({ owner: to.id, event }), ownerWaitMs: 60 });
    registerAppConversation(record("conv-a"));
  });

  afterEach(() => {
    appToolBroker.conversationEnded("conv-a");
    appToolBroker.configure(null);
    resetAppRegistryForTests();
  });

  test("a call goes to the owner and resolves with its answer; late and duplicate answers are ignored", async () => {
    const result = appToolBroker.call("conv-a", "call-1", "lookup", { word: "zorp" });
    expect(sent).toEqual([{ owner: "c1", event: { type: "app_tool_call", convId: "conv-a", callId: "call-1", name: "lookup", input: { word: "zorp" } } }]);
    expect(appToolBroker.resolve("conv-a", "call-1", "a frog", false)).toBe(true);
    expect(await result).toEqual({ output: "a frog", isError: false });
    expect(appToolBroker.resolve("conv-a", "call-1", "again", false)).toBe(false);
    expect(appToolBroker.resolve("conv-a", "unknown", "x", true)).toBe(false);
  });

  test("isError reaches the model as an error result", async () => {
    const result = appToolBroker.call("conv-a", "call-2", "lookup", {});
    appToolBroker.resolve("conv-a", "call-2", "no such word", true);
    expect(await result).toEqual({ output: "no such word", isError: true });
  });

  test("a timeout cancels the call with reason timeout and gives an error result", async () => {
    const deadline = new AbortController();
    const result = appToolBroker.call("conv-a", "call-3", "lookup", {}, deadline.signal);
    deadline.abort(toolTimeoutReason("lookup", 1000));
    expect((await result).isError).toBe(true);
    expect(sent.at(-1)?.event).toEqual({ type: "app_tool_cancel", convId: "conv-a", callId: "call-3", reason: "timeout" });
    expect(appToolBroker.resolve("conv-a", "call-3", "late", false)).toBe(false);
  });

  test("an abort cancels the call with reason aborted", async () => {
    const turn = new AbortController();
    const result = appToolBroker.call("conv-a", "call-4", "lookup", {}, turn.signal);
    turn.abort();
    expect((await result).isError).toBe(true);
    expect(sent.at(-1)?.event).toEqual({ type: "app_tool_cancel", convId: "conv-a", callId: "call-4", reason: "aborted" });
    expect(appToolBroker.pendingCount("conv-a")).toBe(0);
  });

  test("a daemon going away tells the owner its pending calls are moot; the turn's abort settles them", async () => {
    const turn = new AbortController();
    const result = appToolBroker.call("conv-a", "call-9", "lookup", {}, turn.signal);
    expect(appToolBroker.cancelAllForShutdown()).toBe(1);
    expect(sent.at(-1)?.event).toEqual({ type: "app_tool_cancel", convId: "conv-a", callId: "call-9", reason: "aborted" });
    expect(appToolBroker.pendingCount("conv-a")).toBe(1);
    turn.abort();
    expect((await result).isError).toBe(true);
  });

  test("the owner wait can follow the owner's session (its reconnect grace)", async () => {
    owner = null;
    appToolBroker.configure({ owner: () => owner, send: (to, event) => sent.push({ owner: to.id, event }), ownerWaitMs: convId => convId === "conv-grace" ? 5_000 : 30 });
    const quick = appToolBroker.call("conv-a", "call-10", "lookup", {});
    const patient = appToolBroker.call("conv-grace", "call-11", "lookup", {});
    expect((await quick).output).toMatch(/not connected/);
    owner = { id: "back" };
    expect(appToolBroker.ownerAttached("conv-grace")).toBe(1);
    expect(appToolBroker.resolve("conv-grace", "call-11", "answered", false)).toBe(true);
    expect((await patient).output).toBe("answered");
  });

  test("with no owner it waits for one to attach, then sends the call to it", async () => {
    owner = null;
    const result = appToolBroker.call("conv-a", "call-5", "lookup", {});
    expect(sent).toEqual([]);
    owner = { id: "c2" };
    expect(appToolBroker.ownerAttached("conv-a")).toBe(1);
    expect(sent).toEqual([{ owner: "c2", event: { type: "app_tool_call", convId: "conv-a", callId: "call-5", name: "lookup", input: {} } }]);
    appToolBroker.resolve("conv-a", "call-5", "ok", false);
    expect(await result).toEqual({ output: "ok", isError: false });
  });

  test("with no owner within the wait, the model is told the app is not connected", async () => {
    owner = null;
    expect(await appToolBroker.call("conv-a", "call-6", "lookup", {})).toEqual({ output: "demo is not connected", isError: true });
  });

  test("an owner that leaves mid-call hands it to the next one to attach", async () => {
    const result = appToolBroker.call("conv-a", "call-7", "lookup", {});
    owner = null;
    appToolBroker.ownerDetached("conv-a");
    owner = { id: "c3" };
    appToolBroker.ownerAttached("conv-a");
    expect(sent.map(entry => entry.owner)).toEqual(["c1", "c3"]);
    appToolBroker.resolve("conv-a", "call-7", "done", false);
    expect(await result).toEqual({ output: "done", isError: false });
  });

  test("an owner that leaves and never comes back fails the call after the wait", async () => {
    const result = appToolBroker.call("conv-a", "call-8", "lookup", {});
    owner = null;
    appToolBroker.ownerDetached("conv-a");
    expect(await result).toEqual({ output: "demo is not connected", isError: true });
  });

  test("ending the conversation fails its calls and cancels them with reason ended", async () => {
    const result = appToolBroker.call("conv-a", "call-9", "lookup", {});
    appToolBroker.conversationEnded("conv-a");
    expect((await result).isError).toBe(true);
    expect(sent.at(-1)?.event).toEqual({ type: "app_tool_cancel", convId: "conv-a", callId: "call-9", reason: "ended" });
  });

  test("app tools resolve as registry tools for their own conversation only, shown under the app's name", async () => {
    expect(appToolFor("conv-a", "lookup")?.display.label).toBe("demo");
    expect(appToolFor("conv-a", "lookup")?.watchdogExempt).toBe(true);
    expect(appToolFor("conv-a", "lookup")?.defaultTimeoutMs).toBe(10 * 60_000);
    expect(appToolFor("conv-b", "lookup")).toBeUndefined();
    expect(appToolFor("conv-a", "bash")).toBeUndefined();
    expect(appToolCallView("conv-a")("lookup", { word: "zorp" })).toEqual({
      summary: "lookup --word zorp",
      presentation: { toolStyle: { name: "lookup", label: "demo", color: expect.any(String) } },
    });
    expect(appToolCallView("conv-b")("lookup", {})).toBeUndefined();
    const execution = appToolFor("conv-a", "lookup")!.execute({ word: "x" }, { toolCallId: "call-10" });
    appToolBroker.resolve("conv-a", "call-10", "via registry", false);
    expect(await execution).toEqual({ output: "via registry", isError: false });
  });
});
