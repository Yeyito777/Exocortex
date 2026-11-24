import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutor } from "../../agent";
import type { ApiMessage } from "../../messages";
import type { ProviderRound, StreamCallbacks } from "../types";
import { attachBridgeTarget, closeBridgeForTest, HOOK_SCRIPT, MCP_BRIDGE_SCRIPT } from "./bridge";
import { ensureExocortexHook, HOOK_COMMAND, HOOK_ENTRY_NAME } from "./hooks";
import { agyModelLevel, FALLBACK_GEMINI_MODELS, listAgyModels, parseAgyModels } from "./models";
import { invalidateGeminiSignIn, requireGeminiAuth } from "./auth";
import { classifyNetworkFailure } from "../errors";
import { getConversationTasks } from "../../conversation-activity";
import { ConnectivityMonitor } from "../../connectivity";
import { FakeClock, flush, scriptedProbe } from "../../connectivity-test-helpers";
import { runWithNetworkWait } from "../../network-wait";
import { RetryableStreamAbortController } from "../../watchdog-retry";
import { antigravityKindStyle, getAntigravityToolDisplayInfo, summarizeAntigravityTool } from "../../tools/antigravity";
import { summarizeTool } from "../../tools/registry";
import { buildGeminiPromptContent, planGeminiPrompt, resetSessionHeadsForTest, setSessionHead } from "./prompt";
import { closeAllGeminiProcesses, configureGeminiSessions, fingerprintOf, geminiToolDenial, openGeminiProcess, setGeminiPromptWatchForTest, translateAcpError } from "./session";
import { createGeminiStreamState, diffText, pushGeminiUpdate } from "./stream";
import type { AgyTranscriptReader } from "./transcript";
import { geminiQuotaLimits, geminiUsageAvailability, parseUsageScreen, setGeminiQuotaForTest } from "./usage";

const FAKE_AGY = join(import.meta.dir, "test-fixtures", "fake-agy.ts");
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "gemini-test-"));
  const wrapper = join(dir, "agy");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AGY}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  process.env.EXOCORTEX_AGY_BIN = wrapper;
  process.env.EXOCORTEX_AGY_STATE_DIR = join(dir, "agy-state");
});

afterEach(() => {
  closeAllGeminiProcesses("test over");
  setGeminiQuotaForTest(null);
  setGeminiPromptWatchForTest(null);
  configureGeminiSessions(null);
  delete process.env.FAKE_AGY_MODELS_TIMEOUT;
  delete process.env.FAKE_AGY_OFFLINE;
});

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await Bun.sleep(5);
  }
}

afterAll(() => {
  closeBridgeForTest();
});

function callbacks(rounds: ProviderRound[] = [], text: string[] = []): StreamCallbacks {
  return {
    onText: chunk => { text.push(chunk); },
    onThinking: () => {},
    onProviderRound: round => { rounds.push(round); },
  };
}

describe("models", () => {
  test("agy models lists one model per family with its levels as efforts, Gemini only", () => {
    const models = parseAgyModels([
      "Fetching available models...",
      "gemini-4-neon-high\tGemini 4 Neon (High)",
      "gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)",
      "gemini-4-argon-low\tGemini 4 Argon (Low)",
      "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
      "gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)",
      "gemini-4-carbon-medium\tGemini 4 Carbon (Medium)",
      "gemini-pro-orchestrator-neon\tOrchestrator (Neon)",
      "claude-opus-5-5-high\tClaude Opus 5.5 (High)",
    ].join("\n"));
    expect(models.map(m => m.id)).toEqual(["gemini-4-neon", "gemini-4-carbon", "gemini-4-hydrogen", "gemini-4-argon", "gemini-3.8-flash"]);
    expect(models[0].label).toBe("Gemini 4 Neon");
    expect(models[0].supportedEfforts.map(e => e.effort)).toEqual(["high", "xhigh"]);
    expect(models[0].defaultEffort).toBe("high");
    expect(models[3].defaultEffort).toBe("low");
  });

  test("efforts map onto the levels a family has", () => {
    const argon = FALLBACK_GEMINI_MODELS.find(m => m.id === "gemini-4-argon")!;
    const neon = FALLBACK_GEMINI_MODELS.find(m => m.id === "gemini-4-neon")!;
    expect(agyModelLevel(neon, "max")).toBe("xhigh");
    expect(agyModelLevel(argon, "xhigh")).toBe("high");
    expect(agyModelLevel(argon, "none")).toBe("low");
    expect(agyModelLevel(neon, undefined)).toBe("high");
  });
});

describe("usage", () => {
  const screen = [
    "\x1b[1m└ Models & Quota\x1b[0m",
    "  Account: someone@example.com",
    "GEMINI MODELS",
    "  Models within this group: Gemini 4 Neon, Gemini 4 Hydrogen",
    "  Weekly Limit Remaining",
    "[██████████] 97.42%",
    "Refreshes in 167h 41m",
    "  Five Hour Limit Remaining",
    "[██████████] 0.00%",
    "Refreshes in 2h 5m",
    "CLAUDE AND GPT MODELS",
    "  Weekly Limit Remaining",
    "[██████████] 100.00%",
    "Quota available",
    "GEMINI 4 ARGON",
    "  Gemini 4 Argon Weekly Limit",
    "[██████████] 100.00%",
    "Quota available",
  ].join("\r\n");

  test("the /usage screen reads as used percentages with reset times", () => {
    const now = 1_000_000;
    const report = parseUsageScreen(screen, now)!;
    expect(report.account).toBe("someone@example.com");
    const gemini = report.groups.find(g => g.name === "GEMINI MODELS")!;
    expect(gemini.weekly).toEqual({ utilization: 2.58, resetsAt: now + (167 * 60 + 41) * 60_000 });
    expect(gemini.fiveHour).toEqual({ utilization: 100, resetsAt: now + (2 * 60 + 5) * 60_000 });
    expect(report.groups.find(g => g.name === "GEMINI 4 ARGON")!.weekly).toEqual({ utilization: 0, resetsAt: null });
    expect(parseUsageScreen("no usage here")).toBeNull();
  });

  test("a spent window holds Gemini turns until it resets; Argon has its own", () => {
    const now = 1_000_000;
    setGeminiQuotaForTest(parseUsageScreen(screen, now));
    expect(geminiUsageAvailability("gemini-4-neon", now)).toEqual({ ready: false, resetAt: now + 125 * 60_000 });
    expect(geminiUsageAvailability("gemini-4-argon", now).ready).toBe(true);
    expect(geminiUsageAvailability("gemini-4-neon", now + 126 * 60_000).ready).toBe(true);
  });

  test("the Accounts screen gets the shared limits the usage bars show, and Argon's own", () => {
    const now = 1_000_000;
    const report = parseUsageScreen(screen, now)!;
    expect(geminiQuotaLimits(report)).toEqual({
      shared: { fiveHour: { utilization: 100, resetsAt: now + 125 * 60_000 }, weekly: { utilization: 2.58, resetsAt: now + (167 * 60 + 41) * 60_000 } },
      argon: { fiveHour: null, weekly: { utilization: 0, resetsAt: null } },
    });
    expect(geminiQuotaLimits({ account: null, groups: [{ name: "CLAUDE AND GPT MODELS", weekly: null, fiveHour: null }] })).toEqual({ shared: null, argon: null });
  });

  test("Argon follows the shared Gemini limits when the screen lists none of its own (CLI 1.5.16)", () => {
    const now = 1_000_000;
    setGeminiQuotaForTest(parseUsageScreen(screen.split("\r\nGEMINI 4 ARGON")[0], now));
    expect(geminiUsageAvailability("gemini-4-argon", now)).toEqual({ ready: false, resetAt: now + 125 * 60_000 });
    expect(geminiUsageAvailability("gemini-4-carbon", now).ready).toBe(false);
  });
});

describe("prompt planning", () => {
  test("a session continues only from its newest point", () => {
    resetSessionHeadsForTest();
    const cwd = "/w";
    const messages: ApiMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: [{ type: "text", text: "b" }], providerData: { gemini: { sessionId: "s1", mark: "m1", cwd } } },
      { role: "user", content: "c" },
    ];
    setSessionHead("s1", "m1");
    expect(planGeminiPrompt(messages, cwd)).toEqual({ resume: { sessionId: "s1", mark: "m1", cwd }, pending: [messages[2]] });
    // The session went past this point (history was rewound): start over.
    setSessionHead("s1", "m2");
    expect(planGeminiPrompt(messages, cwd)).toEqual({ resume: null, pending: messages });
    setSessionHead("s1", "m1");
    expect(planGeminiPrompt(messages, "/elsewhere").resume).toBeNull();
  });

  test("unseen history goes as a transcript, new user messages natively with images", () => {
    const content = buildGeminiPromptContent([
      { role: "user", content: "old question" },
      { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "text", text: "new" }] },
    ]);
    expect(content[0].type).toBe("text");
    expect((content[0] as { text: string }).text).toContain("<conversation_history>");
    expect((content[0] as { text: string }).text).toContain("old answer");
    expect(content[1]).toEqual({ type: "image", mimeType: "image/png", data: "AAAA" });
    expect(content[2]).toEqual({ type: "text", text: "new" });
  });
});

describe("tool gate", () => {
  test("refuses the CLI's own subagent, scheduler and question tools", () => {
    expect(geminiToolDenial({ name: "invoke_subagent", args: {} }, "/")).toContain("exo");
    expect(geminiToolDenial({ name: "schedule", args: {} }, "/")).toContain("chrono");
    expect(geminiToolDenial({ name: "ask_question", args: {} }, "/")).toContain("mid-turn");
    expect(geminiToolDenial({ name: "run_command", args: { CommandLine: "echo hi" } }, "/")).toBeNull();
    expect(geminiToolDenial({ name: "mcp_exocortex_exo", args: {} }, "/")).toBeNull();
  });

  test("the hook adds Exocortex's entry and keeps the owner's own hooks", () => {
    const path = join(dir, "hooks.json");
    writeFileSync(path, JSON.stringify({ mine: { PreToolUse: [] } }));
    expect(ensureExocortexHook(path)).toBe(true);
    expect(ensureExocortexHook(path)).toBe(false);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.mine).toEqual({ PreToolUse: [] });
    expect(written[HOOK_ENTRY_NAME].PreToolUse[0].hooks[0].command).toBe(HOOK_COMMAND);
    writeFileSync(path, "{ not json");
    expect(ensureExocortexHook(path)).toBe(false);
  });

  async function runHook(env: Record<string, string>, toolName: string): Promise<string> {
    const proc = Bun.spawn(["sh", "-c", HOOK_COMMAND], { env: { ...process.env, ...env }, stdin: "pipe", stdout: "pipe" });
    proc.stdin.write(JSON.stringify({ toolCall: { name: toolName, args: {} }, cwd: "/" }));
    proc.stdin.end();
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return output.trim();
  }

  test("the hook asks the daemon and prints its deny; outside Exocortex it says nothing", async () => {
    const bridge = attachBridgeTarget({
      tools: () => ({ tools: [], instructions: "" }),
      call: async () => ({ text: "", isError: true }),
      preToolUse: call => call.name === "schedule" ? { decision: "deny", reason: "use chrono" } : null,
    });
    try {
      const env = { EXOCORTEX_GEMINI_HOOK: HOOK_SCRIPT, EXOCORTEX_GEMINI_BUN: process.execPath, EXOCORTEX_GEMINI_SOCKET: bridge.socketPath, EXOCORTEX_GEMINI_TOKEN: bridge.token };
      expect(JSON.parse(await runHook(env, "schedule"))).toEqual({ decision: "deny", reason: "use chrono" });
      expect(await runHook(env, "run_command")).toBe("");
      expect(await runHook({ EXOCORTEX_GEMINI_HOOK: "" }, "schedule")).toBe("");
    } finally {
      bridge.release();
    }
  });
});

describe("MCP bridge", () => {
  test("a call the CLI cancels (its three-minute tool limit) stops in the daemon and gets no reply", async () => {
    let started = false;
    let aborted = false;
    const bridge = attachBridgeTarget({
      tools: () => ({ tools: [], instructions: "" }),
      call: (_name, _args, signal) => new Promise(resolve => {
        started = true;
        signal.addEventListener("abort", () => { aborted = true; resolve({ text: "stopped", isError: true }); }, { once: true });
      }),
      preToolUse: () => null,
    });
    const proc = Bun.spawn([process.execPath, MCP_BRIDGE_SCRIPT], {
      env: { ...process.env, EXOCORTEX_GEMINI_SOCKET: bridge.socketPath, EXOCORTEX_GEMINI_TOKEN: bridge.token },
      stdin: "pipe", stdout: "pipe", stderr: "inherit",
    });
    const send = (message: Record<string, unknown>) => { proc.stdin.write(`${JSON.stringify(message)}\n`); proc.stdin.flush(); };
    try {
      send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "chrono", arguments: { action: "wait" } } });
      await until(() => started);
      send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7, reason: "context deadline exceeded" } });
      await until(() => aborted);
      send({ jsonrpc: "2.0", id: 8, method: "ping" });
      const reader = proc.stdout.getReader();
      const { value } = await reader.read();
      expect(JSON.parse(new TextDecoder().decode(value).split("\n")[0])).toEqual({ jsonrpc: "2.0", id: 8, result: {} });
    } finally {
      proc.kill();
      bridge.release();
    }
  });
});

describe("errors", () => {
  test("quota and sign-in failures become the errors Exocortex acts on", () => {
    expect(translateAcpError(new Error("RESOURCE_EXHAUSTED: quota exceeded")).name).toBe("GeminiQuotaError");
    expect(translateAcpError(new Error("RESOURCE_EXHAUSTED: quota exceeded")).message).toContain("usage limit");
    expect(translateAcpError(new Error("authentication required")).name).toBe("AuthError");
  });
});

describe("Antigravity process", () => {
  const cwd = () => dir;
  const key = () => ({ cwd: cwd(), fingerprint: fingerprintOf("sys", []) });
  const chronoDef = { name: "chrono", description: "Clock", input_schema: { type: "object", properties: {} } };

  test("a turn streams text and thinking, applies model and effort, and records its resume point", async () => {
    resetSessionHeadsForTest();
    const proc = openGeminiProcess("c1", key(), "sys", []);
    await proc.initialize();
    expect(await proc.openSession(null)).toBe(false);
    const model = FALLBACK_GEMINI_MODELS.find(m => m.id === "gemini-4-hydrogen")!;
    await proc.configure("gemini-4-hydrogen", model, "low");
    const text: string[] = [];
    const state = createGeminiStreamState(callbacks([], text), cwd(), proc.sessionId!);
    const result = await proc.prompt(state, [{ type: "text", text: "hello" }, { type: "image", mimeType: "image/png", data: "AAAA" }], undefined, undefined);
    expect(result.text).toBe("echo(gemini-4-hydrogen/low, images=1): hello");
    expect(result.thinking).toBe("thinking");
    expect(result.outputTokens).toBe(10);
    const mark = result.assistantProviderData?.gemini;
    expect(mark?.sessionId).toBe(proc.sessionId!);
    expect(proc.head).toBe(mark!.mark);
    const plan = planGeminiPrompt([{ role: "user", content: "hello" }, ...(result.transcriptMessages ?? [])], cwd());
    expect(plan.resume?.mark).toBe(mark!.mark);
  });

  test("a tool round is committed with a resume mark as soon as it closes", async () => {
    const proc = openGeminiProcess("c2", key(), "sys", []);
    await proc.initialize();
    await proc.openSession(null);
    const rounds: ProviderRound[] = [];
    const state = createGeminiStreamState(callbacks(rounds), cwd(), proc.sessionId!);
    const result = await proc.prompt(state, [{ type: "text", text: "shell please" }], undefined, undefined);
    expect(rounds).toHaveLength(1);
    const [assistant, results] = rounds[0].messages;
    expect(assistant.content).toEqual([{ type: "tool_use", id: "call_sh_1", name: "run_command", input: { CommandLine: "echo hi" } }]);
    expect(results.content).toEqual([{ type: "tool_result", tool_use_id: "call_sh_1", content: "Command output:\nhi\n", is_error: false }]);
    expect(results.providerData?.gemini?.mark).toBeTruthy();
    expect(result.text).toBe("ran it");
    expect(result.inputTokens).toBe(1234);
  });

  test("host tools run through the turn's executor over the MCP bridge, under the announced call id", async () => {
    const proc = openGeminiProcess("c3", key(), "sys", [chronoDef]);
    await proc.initialize();
    await proc.openSession(null);
    const seen: { id: string; name: string; input: Record<string, unknown> }[] = [];
    const execute: ToolExecutor = async calls => calls.map(call => {
      seen.push(call);
      return { toolCallId: call.id, toolName: call.name, output: `slept ${String(call.input.duration)}`, isError: false };
    });
    const rounds: ProviderRound[] = [];
    const state = createGeminiStreamState(callbacks(rounds), cwd(), proc.sessionId!);
    const result = await proc.prompt(state, [{ type: "text", text: 'host chrono {"action":"sleep","duration":"1s"}' }], execute, undefined);
    expect(seen).toEqual([{ id: "call_host_1", name: "chrono", input: { action: "sleep", duration: "1s" } }]);
    expect(rounds[0].messages[1].content).toEqual([{ type: "tool_result", tool_use_id: "call_host_1", content: "slept 1s", is_error: false }]);
    expect(result.text).toBe("tool said: slept 1s");
  });

  test("an abort cancels the prompt and keeps the process for the next turn", async () => {
    const proc = openGeminiProcess("c4", key(), "sys", []);
    await proc.initialize();
    await proc.openSession(null);
    const controller = new AbortController();
    const state = createGeminiStreamState(callbacks(), cwd(), proc.sessionId!);
    const running = proc.prompt(state, [{ type: "text", text: "slow" }], undefined, controller.signal);
    for (let i = 0; i < 100 && !proc.busy; i++) await Bun.sleep(5);
    controller.abort();
    await expect(running).rejects.toThrow();
    expect(proc.closed).toBe(false);
    const next = await proc.prompt(createGeminiStreamState(callbacks(), cwd(), proc.sessionId!), [{ type: "text", text: "again" }], undefined, undefined);
    expect(next.text).toContain("again");
  });

  test("a prompt sent right after a cancel (a steer) is not stopped by that cancel's grace timer", async () => {
    setGeminiPromptWatchForTest({ cancelGraceMs: 40 });
    const proc = openGeminiProcess("c4b", key(), "sys", []);
    await proc.initialize();
    await proc.openSession(null);
    const first = new AbortController();
    const running = proc.prompt(createGeminiStreamState(callbacks(), cwd(), proc.sessionId!), [{ type: "text", text: "slow" }], undefined, first.signal);
    await until(() => proc.busy);
    first.abort();
    await expect(running).rejects.toThrow();
    const second = new AbortController();
    const steered = proc.prompt(createGeminiStreamState(callbacks(), cwd(), proc.sessionId!), [{ type: "text", text: "slow" }], undefined, second.signal);
    await until(() => proc.busy);
    await Bun.sleep(120);
    expect(proc.closed).toBe(false);
    second.abort();
    await expect(steered).rejects.toThrow();
    expect(proc.closed).toBe(false);
  });

  test("a session the CLI no longer has starts a new one", async () => {
    const proc = openGeminiProcess("c5", key(), "sys", []);
    await proc.initialize();
    expect(await proc.openSession("missing-session")).toBe(false);
    expect(proc.sessionId).toStartWith("fake-session-");
    const other = openGeminiProcess("c6", key(), "sys", []);
    await other.initialize();
    expect(await other.openSession("kept-session")).toBe(true);
    expect(other.sessionId).toBe("kept-session");
  });
});

describe("network trouble", () => {
  const cwd = () => dir;
  const key = () => ({ cwd: cwd(), fingerprint: fingerprintOf("sys", []) });

  test("agy models timing out offline is a network failure, and does not cache a sign-out", async () => {
    process.env.FAKE_AGY_MODELS_TIMEOUT = "1";
    invalidateGeminiSignIn();
    const error = await listAgyModels().then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(classifyNetworkFailure(error)).toBe("network");
    const auth = await requireGeminiAuth().then(() => null, (e: unknown) => e);
    expect((auth as Error).name).not.toBe("AuthError");
    expect(classifyNetworkFailure(auth)).toBe("network");
    // Back online: the next check runs again and passes (no cached "not signed in").
    delete process.env.FAKE_AGY_MODELS_TIMEOUT;
    await requireGeminiAuth();
  });

  test("a turn whose sign-in check timed out offline waits for the network and runs again", async () => {
    process.env.FAKE_AGY_MODELS_TIMEOUT = "1";
    invalidateGeminiSignIn();
    const clock = new FakeClock();
    const probe = scriptedProbe(false);
    const monitor = new ConnectivityMonitor({ probe, clock });
    const controller = new RetryableStreamAbortController();
    const waits: string[] = [];
    let calls = 0;
    let done = false;
    const run = runWithNetworkWait(controller, monitor, async () => { calls += 1; await requireGeminiAuth(); return "ran"; }, {
      onWaitStart: () => { waits.push("start"); },
      onWaitEnd: () => { waits.push("end"); },
    }).then(value => { done = true; return value; });
    await until(() => !monitor.isOnline());
    expect(calls).toBe(1);
    expect(done).toBe(false);
    delete process.env.FAKE_AGY_MODELS_TIMEOUT;
    probe.reachable = true;
    await clock.advance(3_000);
    expect(await run).toBe("ran");
    expect(calls).toBe(2);
    expect(waits).toEqual(["start", "end"]);
    await flush();
  });

  test("a session that came up without its model list (offline) fails as a network failure", async () => {
    process.env.FAKE_AGY_OFFLINE = "1";
    const proc = openGeminiProcess("n1", key(), "sys", []);
    await proc.initialize();
    await proc.openSession(null);
    const error = await proc.configure("gemini-4-neon", FALLBACK_GEMINI_MODELS[0], "high").then(() => null, (e: unknown) => e);
    expect(classifyNetworkFailure(error)).toBe("network");
    expect((error as Error).message).toContain("could not reach Google");
  });

  test("a model call silent after the network dropped is stopped once it is back, as a network failure, keeping the process", async () => {
    let online = true;
    setGeminiPromptWatchForTest({ tickMs: 10, silentMs: 40, recoverMs: 40, isOnline: () => online });
    const proc = openGeminiProcess("n2", key(), "sys", []);
    await proc.initialize();
    await proc.openSession(null);
    let troubles = 0;
    let activity = 0;
    const state = createGeminiStreamState({ ...callbacks(), onNetworkTrouble: () => { troubles += 1; }, onActivity: () => { activity += 1; } }, cwd(), proc.sessionId!);
    let settled: unknown = null;
    const running = proc.prompt(state, [{ type: "text", text: "slow" }], undefined, undefined).then(() => "resolved", (e: unknown) => { settled = e; return "rejected"; });
    // Silent with the network up: the daemon is asked to check it.
    await until(() => troubles > 0);
    online = false;
    const before = activity;
    await Bun.sleep(80);
    expect(settled).toBeNull();
    // Waiting on the network is not a stale stream.
    expect(activity).toBeGreaterThan(before);
    online = true;
    expect(await running).toBe("rejected");
    expect(classifyNetworkFailure(settled)).toBe("network");
    expect(proc.closed).toBe(false);
    const next = await proc.prompt(createGeminiStreamState(callbacks(), cwd(), proc.sessionId!), [{ type: "text", text: "again" }], undefined, undefined);
    expect(next.text).toContain("again");
  });
});

describe("long-running commands", () => {
  const cwd = () => dir;
  const key = () => ({ cwd: cwd(), fingerprint: fingerprintOf("sys", []) });

  test("a command the CLI moves to the background keeps the turn alive, is listed as a task, and finishes with its output", async () => {
    setGeminiPromptWatchForTest({ tickMs: 10, silentMs: 150, recoverMs: 150, isOnline: () => true });
    const changed: string[] = [];
    configureGeminiSessions({ tasksChanged: convId => { changed.push(convId); } });
    const proc = openGeminiProcess("bg1", key(), "sys", []);
    await proc.initialize();
    await proc.openSession(null);
    const rounds: ProviderRound[] = [];
    let activity = 0;
    let troubles = 0;
    const rates: number[] = [];
    const state = createGeminiStreamState({
      ...callbacks(rounds),
      onActivity: () => { activity += 1; },
      onNetworkTrouble: () => { troubles += 1; },
      onGenerationRate: rate => { rates.push(rate); },
    }, cwd(), proc.sessionId!);
    const running = proc.prompt(state, [{ type: "text", text: "background 400" }], undefined, undefined);
    await until(() => getConversationTasks("bg1").length === 1);
    const [task] = getConversationTasks("bg1");
    expect(task.kind).toBe("background");
    expect(task.id).toBe(`${proc.sessionId}/task-2`);
    expect(task.title).toBe("make long-job");
    const result = await running;
    // Heartbeats while the command ran; no network check for a command's silence.
    expect(activity).toBeGreaterThan(5);
    expect(troubles).toBe(0);
    expect(getConversationTasks("bg1")).toEqual([]);
    expect(changed.filter(id => id === "bg1").length).toBeGreaterThanOrEqual(2);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].messages[1].content).toEqual([{ type: "tool_result", tool_use_id: "call_bg_1", content: "Command exited with code 0.\n\nCommand output:\nbuilt\n", is_error: false }]);
    // The round carries its model calls' tokens from the CLI's log; the rest is the last call's.
    expect(rounds[0].outputTokens).toBe(46);
    expect(result.outputTokens).toBe(51);
    // The round held two model calls too short to time from the log's seconds; the last call has its rate.
    expect(rates).toHaveLength(1);
    expect(rates.every(rate => rate > 0)).toBe(true);
    expect(rounds[0].blocks.map(block => block.type)).toEqual(["tool_call", "text", "tool_result"]);
    expect(result.text).toBe("built it");
  });

  test("a chrono wait on a task the agent was just told about finds it listed", async () => {
    setGeminiPromptWatchForTest({ tickMs: 60_000, silentMs: 60_000, recoverMs: 60_000, isOnline: () => true });
    const chronoDef = { name: "chrono", description: "Clock", input_schema: { type: "object", properties: {} } };
    const proc = openGeminiProcess("bg3", key(), "sys", [chronoDef]);
    await proc.initialize();
    await proc.openSession(null);
    const listed: string[][] = [];
    const execute: ToolExecutor = async calls => calls.map(call => {
      listed.push(getConversationTasks("bg3").map(task => task.id));
      return { toolCallId: call.id, toolName: call.name, output: `waited on ${String(call.input.task_id)}`, isError: false };
    });
    const state = createGeminiStreamState(callbacks(), cwd(), proc.sessionId!);
    await proc.prompt(state, [{ type: "text", text: "background 50 then-wait" }], execute, undefined);
    expect(listed).toEqual([[`${proc.sessionId}/task-2`]]);
    expect(getConversationTasks("bg3")).toEqual([]);
  });

  test("a command stopped by a cancel reads as interrupted, not failed", async () => {
    const proc = openGeminiProcess("bg2", key(), "sys", []);
    await proc.initialize();
    await proc.openSession(null);
    const rounds: ProviderRound[] = [];
    const controller = new AbortController();
    const state = createGeminiStreamState(callbacks(rounds), cwd(), proc.sessionId!);
    const running = proc.prompt(state, [{ type: "text", text: "stop-tool" }], undefined, controller.signal);
    await until(() => state.openToolUses.size === 1);
    controller.abort();
    await expect(running).rejects.toThrow();
    const results = rounds.flatMap(round => round.messages).flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === "tool_result");
    expect(results).toEqual([{ type: "tool_result", tool_use_id: "call_stop_1", content: "Interrupted before this tool call finished.", is_error: true }]);
  });
});

describe("tool display", () => {
  test("the CLI's tools look like their Exocortex counterparts", () => {
    const display = new Map(getAntigravityToolDisplayInfo().map(info => [info.name, info]));
    const editColor = display.get("replace_file_content")!.color;
    expect(display.get("edit_file")).toEqual({ name: "edit_file", label: "Edit", color: editColor });
    expect(display.get("write_file")?.label).toBe("Write");
    expect(display.get("read_file")?.label).toBe("Read");
    expect(display.get("manage_task")?.label).toBe("Task");
    expect(summarizeAntigravityTool("edit_file", { Path: "/w/a.txt", Target: "beta", Replacement: "gamma" })).toEqual({ label: "Edit", detail: "/w/a.txt" });
    expect(summarizeAntigravityTool("write_file", { Path: "/w/b.txt", Content: "x", Overwrite: true }).detail).toStartWith("/w/b.txt");
    expect(summarizeAntigravityTool("read_file", { Path: "/w/a.txt", StartLine: 10, EndLine: 19 })).toEqual({ label: "Read", detail: "/w/a.txt --offset 10 --limit 10" });
    expect(summarizeAntigravityTool("manage_task", { Action: "kill", TaskId: "d3e7/task-77" })).toEqual({ label: "Task", detail: "kill task-77" });
    expect(summarizeAntigravityTool("search_web", { query: "flint ntt" })).toEqual({ label: "Search", detail: "flint ntt" });
    expect(antigravityKindStyle("frobnicate_files", "search")?.color).toBe(display.get("grep_search")!.color);
    expect(antigravityKindStyle("edit_file", "edit")).toBeNull();
  });

  test("history re-summarizes the CLI's tools with their own summaries", () => {
    expect(summarizeTool("write_file", { Content: "alpha\nbeta\n", Overwrite: true, Path: "/w/a.txt" })).toEqual({ label: "Write", detail: "/w/a.txt" });
    expect(summarizeTool("edit_file", { Path: "/w/a.txt", Target: "beta", Replacement: "gamma" })).toEqual({ label: "Edit", detail: "/w/a.txt" });
    expect(summarizeTool("manage_task", { Action: "kill", TaskId: "s/task-7" })).toEqual({ label: "Task", detail: "kill task-7" });
    // Claude Code's own tools keep theirs.
    expect(summarizeTool("Write", { file_path: "/w/c.txt", content: "x" }).detail).toBe("/w/c.txt");
  });

  test("an edit's result is its changed lines, a new file its size: never the path again", () => {
    expect(diffText("alpha\nbeta\n", "alpha\ngamma\n")).toBe("@@ line 2 @@\n- beta\n+ gamma");
    expect(diffText(undefined, "one\ntwo\n")).toBe("Wrote 2 lines");
  });

  test("edit rounds record diffs, and an unknown tool takes its kind's look", async () => {
    const proc = openGeminiProcess("ed1", { cwd: dir, fingerprint: fingerprintOf("sys", []) }, "sys", []);
    await proc.initialize();
    await proc.openSession(null);
    const rounds: ProviderRound[] = [];
    const calls: { name: string; presentation?: unknown }[] = [];
    const state = createGeminiStreamState({ ...callbacks(rounds), onToolCall: block => { calls.push({ name: block.toolName, presentation: block.presentation }); } }, dir, proc.sessionId!);
    await proc.prompt(state, [{ type: "text", text: "edits" }], undefined, undefined);
    const outputs = rounds.flatMap(round => round.blocks).flatMap(block => block.type === "tool_result" ? [block.output] : []);
    expect(outputs).toEqual(["@@ line 2 @@\n- beta\n+ gamma", "Wrote 2 lines", "found"]);
    const unknown = calls.find(call => call.name === "frobnicate_files")!;
    expect((unknown.presentation as { toolStyle?: { label: string } }).toolStyle?.label).toBe("frobnicate_files");
  });
});

describe("generation rate", () => {
  test("model calls made while a backgrounded command holds a round open are timed by the CLI's log, not by that round", () => {
    const base = Date.parse("2026-11-24T20:59:00Z");
    let now = base;
    const logged: Record<string, unknown>[] = [];
    const transcript = { read: () => logged.splice(0) } as unknown as AgyTranscriptReader;
    const rates: number[] = [];
    const state = createGeminiStreamState({ ...callbacks(), onGenerationRate: rate => { rates.push(rate); } }, dir, "s-rate", { transcript, now: () => now });
    const at = (ms: number) => new Date(base + ms).toISOString().replace(/\.\d+Z$/, "Z");
    // One model call (5 s, 650 tokens) makes two tool calls, which the CLI runs one after the other.
    logged.push({ type: "PLANNER_RESPONSE", output_tokens: 650, created_at: at(0) });
    now = base + 5_000;
    pushGeminiUpdate(state, { sessionUpdate: "tool_call", toolCallId: "t1", name: "manage_task", rawInput: {}, status: "in_progress" });
    logged.push({ type: "GENERIC", created_at: at(5_000) });
    now = base + 6_000;
    pushGeminiUpdate(state, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: { output: "ok" } });
    // The second goes to the background; the round stays open 84 s while the agent makes another 15 s call.
    now = base + 6_008;
    pushGeminiUpdate(state, { sessionUpdate: "tool_call", toolCallId: "t2", name: "run_command", rawInput: { CommandLine: "make", WaitMsBeforeAsync: 1000 }, status: "in_progress" });
    logged.push({ type: "GENERIC", created_at: at(6_000) });
    logged.push({ type: "PLANNER_RESPONSE", output_tokens: 3000, created_at: at(20_000) });
    logged.push({ type: "GENERIC", created_at: at(35_000) });
    now = base + 90_000;
    pushGeminiUpdate(state, { sessionUpdate: "tool_call_update", toolCallId: "t2", status: "completed", rawOutput: { output: "built" } });
    expect(rates).toEqual([130, 200]);
  });
});
