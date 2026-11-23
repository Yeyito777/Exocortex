import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutor } from "../../agent";
import type { ApiMessage } from "../../messages";
import type { ProviderRound, StreamCallbacks } from "../types";
import { attachBridgeTarget, closeBridgeForTest, HOOK_SCRIPT } from "./bridge";
import { ensureExocortexHook, HOOK_COMMAND, HOOK_ENTRY_NAME } from "./hooks";
import { agyModelLevel, FALLBACK_GEMINI_MODELS, parseAgyModels } from "./models";
import { buildGeminiPromptContent, planGeminiPrompt, resetSessionHeadsForTest, setSessionHead } from "./prompt";
import { closeAllGeminiProcesses, fingerprintOf, geminiToolDenial, openGeminiProcess, translateAcpError } from "./session";
import { createGeminiStreamState } from "./stream";
import { geminiQuotaLimits, geminiUsageAvailability, parseUsageScreen, setGeminiQuotaForTest } from "./usage";

const FAKE_AGY = join(import.meta.dir, "test-fixtures", "fake-agy.ts");
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "gemini-test-"));
  const wrapper = join(dir, "agy");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AGY}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  process.env.EXOCORTEX_AGY_BIN = wrapper;
});

afterEach(() => {
  closeAllGeminiProcesses("test over");
  setGeminiQuotaForTest(null);
});

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
      "gemini-pro-orchestrator-neon\tOrchestrator (Neon)",
      "claude-opus-5-5-high\tClaude Opus 5.5 (High)",
    ].join("\n"));
    expect(models.map(m => m.id)).toEqual(["gemini-4-neon", "gemini-4-hydrogen", "gemini-4-argon", "gemini-3.8-flash"]);
    expect(models[0].label).toBe("Gemini 4 Neon");
    expect(models[0].supportedEfforts.map(e => e.effort)).toEqual(["high", "xhigh"]);
    expect(models[0].defaultEffort).toBe("high");
    expect(models[2].defaultEffort).toBe("low");
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
