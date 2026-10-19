import { afterEach, describe, expect, mock, test } from "bun:test";
import { clearConversationDefaults, saveConversationDefaults, updateExocortexConfig } from "@exocortex/shared/config";
import { createExocortexToolRuntime, type ExocortexToolRuntimeDependencies } from "../exocortex-tool-runtime";
import * as conversations from "../conversations";
import { getActiveSubagentCount, getConversationActivityCounts, resetConversationActivityForTest, setSubagentActive } from "../conversation-activity";
import { buildConversationRequestSurface } from "../conversation-request-surface";
import { setLoadedExternalToolsForTest } from "../external-tools";
import { latestClaudeModel, latestSizeModel } from "../delegation-models";
import { getProvider } from "../providers/registry";
import { MAX_ACTIVE_EXO_SUBAGENTS_GLOBAL, MAX_ACTIVE_EXO_SUBAGENTS_PER_PARENT, MAX_EXO_SUBAGENT_DEPTH } from "../messages";
import { maxSubagentDepth, subagentDepth } from "../subagent-policy";
import { readRequestedRestart, resetRequestedRestartForTest, RESTART_MIN_UPTIME_MS } from "../requested-restart";
import { exo } from "./exo";
import { summarizeClaudeCodeTool } from "./claude-code";

const ids = new Set<string>();
function parent(provider: "openai" | "anthropic" = "openai") {
  const id = `simple-exo-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  ids.add(id);
  return conversations.create(id, provider, provider === "openai" ? "gpt-6-astra" : "claude-sonnet-5-5", "parent");
}
const outcome = { ok: true, blocks: [{ type: "text" as const, text: "done" }], tokens: 1, durationMs: 1, endedAt: Date.now() };
function harness(overrides: Partial<ExocortexToolRuntimeDependencies> = {}) {
  const runTurn = mock(async () => outcome);
  const notifyParent = mock(() => {});
  const beginParentNotification = mock(() => {});
  const completeParentNotification = mock(() => {});
  const runtime = createExocortexToolRuntime({
    server: { broadcast: () => {}, sendToSubscribers: () => {} } as never,
    hasCredentials: () => true, runTurn, notifyParent, beginParentNotification, completeParentNotification,
    ...overrides,
  });
  return { runtime, runTurn, notifyParent, beginParentNotification, completeParentNotification };
}
async function spawn(runtime: ReturnType<typeof harness>["runtime"], parentId: string, args?: unknown) {
  const result = await runtime.execute({ subagent: "Inspect the specified file", ...(args === undefined ? {} : { args }) }, parentId);
  expect(result.isError).toBe(false);
  const childId = JSON.parse(result.output).conversation_id;
  ids.add(childId);
  return conversations.get(childId)!;
}
// Completion callbacks run independently of the immediate tool response.
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
afterEach(async () => {
  await settle();
  resetConversationActivityForTest();
  clearConversationDefaults();
  for (const id of ids) { conversations.clearActiveJob(id); conversations.remove(id); }
  ids.clear();
});

describe("minimal native exo", () => {
  test("schema exposes only subagent/args/message/status/abort/restart with model and effort choices", () => {
    const properties = exo.inputSchema.properties as Record<string, any>;
    expect(Object.keys(properties)).toEqual(["subagent", "args", "message", "status", "abort", "restart"]);
    expect(Object.keys(properties.message.properties)).toEqual(["conversation", "text", "delivery"]);
    expect(properties.message.required).toEqual(["conversation", "text"]);
    expect(properties.message.properties.delivery.enum).toEqual(["now", "after_turn"]);
    expect(exo.systemHint).toContain("subagent always creates a new conversation");
    expect(exo.summarize!({ message: { conversation: "c1", text: "status   update" } }).detail).toBe("message: c1: status update");
    expect(exo.summarize!({ status: "c1" }).detail).toBe("status: c1");
    expect(Object.keys(properties.args.properties)).toEqual(["detach", "model", "effort"]);
    expect(properties.args.properties.model.description).toContain("claude-opus-5-5");
    expect(properties.args.properties.effort.enum).toContain("xhigh");
    expect(exo.systemHint).toContain("Subagents are the default for real work");
    expect(exo.systemHint).toContain("Do trivial or quick work yourself");
    expect(exo.systemHint).not.toContain("Almost never");
    expect(exo.systemHint).toContain("shared/src/protocol.ts");
    expect(exo.systemHint).toContain("restart gracefully restarts this daemon");
    expect(exo.summarize!({ restart: "deploy fix" }).detail).toBe("restart: deploy fix");
  });
  test("a subagent call shows its full instructions, line breaks kept", () => {
    const prompt = `Small TUI fix in Exocortex: ${"inline images disappear ".repeat(10)}\n\nRepo: /tmp/x. Report back.\n`;
    expect(exo.summarize!({ subagent: prompt, args: { model: "opus" } })).toEqual({
      label: "Exocortex",
      detail: `subagent: ${prompt.trim()}`,
    });
    // Claude Code's exo host tool is summarized by the same tool.
    expect(summarizeClaudeCodeTool("exo", { subagent: prompt })).toEqual(exo.summarize!({ subagent: prompt }));
  });
  test("Sol fast is the default independently of user defaults; Astra is the only override", async () => {
    saveConversationDefaults({ provider: "openai", model: "gpt-6-astra", effort: "high", fastMode: false });
    const p = parent();
    const h = harness();
    const sol = await spawn(h.runtime, p.id);
    expect(sol.model).toBe(latestSizeModel("sol", getProvider("openai")!.models.map(model => model.id))!);
    expect(sol.fastMode).toBe(true);
    expect(sol.subagentMaxDepth).toBe(1);
    expect(sol.subagentPolicy?.depth).toBe(1);
    expect(sol.toolPolicy).toBeFalsy();
    const astra = await spawn(h.runtime, p.id, { model: "astra" });
    expect(astra.model).toBe(latestSizeModel("astra", getProvider("openai")!.models.map(model => model.id))!);
    expect(astra.fastMode).toBe(false);
    await settle();
    expect(h.beginParentNotification).toHaveBeenCalledTimes(2);
    expect(h.completeParentNotification).toHaveBeenCalledTimes(2);
    expect(getConversationActivityCounts(p.id).subagentCount).toBe(0);
  });
  test("Claude parents default to Opus at high effort; either family is selectable with an effort", async () => {
    const claude = getProvider("anthropic")!.models.map(model => model.id);
    const openai = getProvider("openai")!.models.map(model => model.id);
    const h = harness();
    const claudeParent = parent("anthropic");
    const opus = await spawn(h.runtime, claudeParent.id);
    expect([opus.provider, opus.model, opus.effort, opus.fastMode]).toEqual(["anthropic", latestClaudeModel("opus", claude)!, "high", false]);
    expect(opus.subagentMaxDepth).toBe(1);
    const sonnet = await spawn(h.runtime, claudeParent.id, { model: "sonnet", effort: "medium" });
    expect([sonnet.model, sonnet.effort]).toEqual([latestClaudeModel("sonnet", claude)!, "medium"]);
    const exact = await spawn(h.runtime, parent().id, { model: "claude-opus-5-5", effort: "max" });
    expect([exact.provider, exact.model, exact.effort]).toEqual(["anthropic", "claude-opus-5-5", "max"]);
    const sol = await spawn(h.runtime, claudeParent.id, { model: "sol fast" });
    expect([sol.provider, sol.model, sol.fastMode]).toEqual(["openai", latestSizeModel("sol", openai)!, true]);
    const response = await h.runtime.execute({ subagent: "Inspect", args: { model: "opus" } }, claudeParent.id);
    ids.add(JSON.parse(response.output).conversation_id);
    expect(JSON.parse(response.output)).toMatchObject({ provider: "anthropic", model: latestClaudeModel("opus", claude), effort: "high" });
  });
  test("rejects models outside the catalog, unsupported efforts, and signed-out providers", async () => {
    const claudeParent = parent("anthropic");
    const h = harness();
    for (const args of [
      { model: "claude-opus-1-0" }, { model: "gpt-6-sol" }, { model: "opus", effort: "ultra" },
      { model: "astra", effort: "minimal" }, { effort: "turbo" },
    ]) expect((await h.runtime.execute({ subagent: "do it", args }, claudeParent.id)).isError).toBe(true);
    const noClaude = harness({ hasCredentials: provider => provider !== "anthropic" });
    const refused = await noClaude.runtime.execute({ subagent: "do it" }, claudeParent.id);
    expect(JSON.parse(refused.output).error).toBe("Not authenticated for provider anthropic");
    await spawn(noClaude.runtime, claudeParent.id, { model: "sol fast" });
    const blocked = harness({ cannotStart: provider => provider === "anthropic" ? "blocked" : null });
    expect((await blocked.runtime.execute({ subagent: "do it", args: { model: "opus" } }, parent().id)).isError).toBe(true);
    expect(h.runTurn).not.toHaveBeenCalled();
    expect(blocked.runTurn).not.toHaveBeenCalled();
  });
  test("detach means no parent notification, not no task tracking", async () => {
    let resolve!: (value: typeof outcome) => void;
    const h = harness({ runTurn: () => new Promise(res => { resolve = res; }) });
    const p = parent();
    await spawn(h.runtime, p.id, { detach: true });
    expect(getConversationActivityCounts(p.id).subagentCount).toBe(1);
    expect(h.beginParentNotification).not.toHaveBeenCalled();
    resolve(outcome);
    await settle();
    expect(h.completeParentNotification).not.toHaveBeenCalled();
    expect(h.notifyParent).not.toHaveBeenCalled();
    expect(getConversationActivityCounts(p.id).subagentCount).toBe(0);
  });
  test("old restrictions cannot remove child tools or external hints", async () => {
    const restore = setLoadedExternalToolsForTest([{
      manifest: { name: "fixture", bin: "./bin/fixture", systemHint: "Fixture external hint", display: { label: "Fixture", color: "#ffffff" } },
      toolDir: "/tmp/fixture", binDir: "/tmp/fixture/bin",
    }]);
    try {
      const p = parent();
      p.toolPolicy = { internal: [], external: [] };
      conversations.setSystemInstructions(p.id, "Inherited safety constraint");
      const child = await spawn(harness().runtime, p.id);
      child.toolPolicy = { internal: ["read"], external: [] };
      child.subagentPolicy!.allowEdits = false;
      const options = { workingDirectory: "/tmp", conversationId: p.id };
      const rootSurface = buildConversationRequestSurface(p, options);
      const childSurface = buildConversationRequestSurface(child, { ...options, conversationId: child.id });
      expect(childSurface.tools).toEqual(rootSurface.tools);
      expect(childSurface.toolNames).toContain("exec_command");
      expect(childSurface.toolNames).toContain("apply_patch");
      expect(childSurface.system).toContain("Fixture external hint");
      expect(conversations.getEffectiveSystemInstructions(child.id)).toContain("Inherited safety constraint");
    } finally { restore(); }
  });
  test("rejects admin actions, parent-selected tools, extra options, and invalid models before mutation", async () => {
    const h = harness();
    const p = parent();
    for (const input of [
      {}, { subagent: "" }, { subagent: "do it", abort: p.id }, { abort: p.id, args: {} },
      { action: "send", text: "do it" }, { action: "commands", command: "tools" },
      { subagent: "do it", allow_edits: true }, { subagent: "do it", internal_tools: ["read"] },
      { subagent: "do it", args: { external_tools: ["fixture"] } },
      { subagent: "do it", args: { model: "sol" } }, { subagent: "do it", args: { model: "terra" } },
      { subagent: "do it", args: { model: 5 } }, { subagent: "do it", args: { effort: "high", extra: true } },
      { subagent: "do it", args: { model: "gpt-6-astra" } }, { subagent: "do it", args: { detach: "yes" } },
      { restart: "x", abort: p.id }, { restart: "x", subagent: "do it" }, { restart: "x", args: {} }, { restart: true },
      { message: { conversation: p.id } }, { message: { text: "hi" } }, { message: "hi" },
      { message: { conversation: "x", text: "hi", delivery: "later" } }, { message: { conversation: "x", text: "hi", extra: 1 } },
      { message: { conversation: "x", text: "hi" }, abort: "x" }, { message: { conversation: "x", text: "hi" }, args: {} },
      { status: 5 }, { status: "x", abort: "x" },
    ]) expect((await h.runtime.execute(input, p.id)).isError).toBe(true);
    expect(h.runTurn).not.toHaveBeenCalled();
    expect(getConversationActivityCounts(p.id).subagentCount).toBe(0);
  });
  describe("nested delegation", () => {
    afterEach(() => updateExocortexConfig(config => { if (config.agent) delete config.agent.maxSubagentDepth; }));
    const setMaxDepth = (depth: number) => updateExocortexConfig(config => { config.agent = { ...config.agent, maxSubagentDepth: depth }; });
    const error = async (result: Promise<{ output: string; isError: boolean }>) => {
      const response = await result;
      expect(response.isError).toBe(true);
      return JSON.parse(response.output).error as string;
    };

    test("by default a child may delegate once and a grandchild is at the limit", async () => {
      const h = harness();
      const p = parent();
      const child = await spawn(h.runtime, p.id);
      const grandchild = await spawn(h.runtime, child.id);
      expect(child.subagentPolicy).toMatchObject({ parentConversationId: p.id, depth: 1 });
      expect(grandchild.subagentPolicy).toMatchObject({ parentConversationId: child.id, depth: 2 });
      expect(grandchild.subagentMaxDepth).toBe(0);
      expect((h.runTurn.mock.calls[1] as unknown[]).slice(0, 3)).toEqual([grandchild.id, "Inspect the specified file", 0]);
      expect(await error(h.runtime.execute({ subagent: "nested" }, grandchild.id)))
        .toBe("Subagent depth limit reached: you are a subagent at depth 2 of 2 and cannot start subagents. Do the work yourself.");
      expect(await error(h.runtime.execute({ subagent: "nested" }, p.id, undefined, 0))).toBe("This turn cannot delegate.");
      expect(h.runTurn).toHaveBeenCalledTimes(2);
    });

    test("the grandchild reports to its own parent, which tracks it", async () => {
      const h = harness({ runTurn: () => new Promise(() => {}) });
      const p = parent();
      const child = await spawn(h.runtime, p.id);
      const grandchild = await spawn(h.runtime, child.id);
      expect(h.beginParentNotification.mock.calls[1] as unknown[])
        .toEqual([{ convId: child.id }, grandchild.id, "Inspect the specified file", expect.any(Number), 0, true]);
      expect(getConversationActivityCounts(p.id).subagentCount).toBe(1);
      expect(getConversationActivityCounts(child.id).subagentCount).toBe(1);
      expect(getActiveSubagentCount()).toBe(2);
    });

    test("the depth limit is configurable, and older child records count as depth 1", async () => {
      const h = harness();
      const p = parent();
      setMaxDepth(1);
      const child = await spawn(h.runtime, p.id);
      expect(child.subagentMaxDepth).toBe(0);
      expect(await error(h.runtime.execute({ subagent: "nested" }, child.id))).toContain("depth 1 of 1");
      setMaxDepth(3);
      const grandchild = await spawn(h.runtime, child.id);
      expect(grandchild.subagentMaxDepth).toBe(1);
      const great = await spawn(h.runtime, grandchild.id);
      expect(great.subagentPolicy?.depth).toBe(3);
      expect(await error(h.runtime.execute({ subagent: "nested" }, great.id))).toContain("depth 3 of 3");
      setMaxDepth(99);
      expect(maxSubagentDepth()).toBe(MAX_EXO_SUBAGENT_DEPTH);
      setMaxDepth(2);
      delete child.subagentPolicy!.depth;
      expect(subagentDepth(child)).toBe(1);
      await spawn(h.runtime, child.id);
    });

    test("each subagent's prompt states its depth and remaining delegation", async () => {
      const h = harness();
      const p = parent("anthropic");
      const child = await spawn(h.runtime, p.id);
      const grandchild = await spawn(h.runtime, child.id);
      const system = (conv: typeof p) => buildConversationRequestSurface(conv, { workingDirectory: "/tmp", conversationId: conv.id }).system;
      expect(system(p)).not.toContain("## Delegation");
      expect(system(child)).toContain(`You are already a subagent, at depth 1 of 2 (parent conversation ${p.id}).`);
      expect(system(child)).toContain("You may start subagents with exo, and they cannot delegate further.");
      expect(system(child)).toContain("Never hand off your whole task, never delegate a task back to your parent");
      expect(system(child)).toContain("chrono wait with task_id set to its conversation id");
      expect(system(grandchild)).toContain("at depth 2 of 2");
      expect(system(grandchild)).toContain("You cannot start subagents of your own");
      expect(system(grandchild)).not.toContain("You may start subagents");
      setMaxDepth(3);
      expect(system(child)).toContain("up to 2 more levels deep");
      expect(exo.systemHint).toContain("Nesting is bounded");
      expect(exo.systemHint).not.toContain("cannot delegate further");
    });

    test("grandchildren count toward the daemon-wide cap", async () => {
      const h = harness({ runTurn: () => new Promise(() => {}) });
      const p = parent();
      const child = await spawn(h.runtime, p.id);
      for (let i = 0; getActiveSubagentCount() < MAX_ACTIVE_EXO_SUBAGENTS_GLOBAL - 1; i++) {
        setSubagentActive(`elsewhere-${Math.floor(i / 4)}`, `busy-${i}`, true, { title: "busy", startedAt: Date.now() });
      }
      await spawn(h.runtime, child.id);
      expect(getActiveSubagentCount()).toBe(MAX_ACTIVE_EXO_SUBAGENTS_GLOBAL);
      expect(await error(h.runtime.execute({ subagent: "one more" }, child.id)))
        .toBe(`Already at the ${MAX_ACTIVE_EXO_SUBAGENTS_GLOBAL}-subagent daemon limit.`);
      expect(await error(h.runtime.execute({ subagent: "one more" }, p.id)))
        .toBe(`Already at the ${MAX_ACTIVE_EXO_SUBAGENTS_GLOBAL}-subagent daemon limit.`);
    });

    test("a child's per-parent cap counts only its own children", async () => {
      const h = harness({ runTurn: () => new Promise(() => {}) });
      const p = parent();
      const child = await spawn(h.runtime, p.id);
      for (let i = 0; i < MAX_ACTIVE_EXO_SUBAGENTS_PER_PARENT; i++) {
        setSubagentActive(child.id, `child-capacity-${i}`, true, { title: "busy", startedAt: Date.now() });
      }
      expect(await error(h.runtime.execute({ subagent: "one more" }, child.id)))
        .toBe(`Already at the ${MAX_ACTIVE_EXO_SUBAGENTS_PER_PARENT}-subagent parent limit.`);
      await spawn(h.runtime, p.id);
    });

    test("message and abort stay limited to direct children at every depth", async () => {
      const h = harness({ runTurn: () => new Promise(() => {}) });
      const p = parent();
      const child = await spawn(h.runtime, p.id);
      const sibling = await spawn(h.runtime, p.id);
      const grandchild = await spawn(h.runtime, child.id);
      const message = (target: string, caller: string) => h.runtime.execute({ message: { conversation: target, text: "hi" } }, caller);
      expect(await error(message(child.id, grandchild.id))).toBe("Subagents can only message their own direct children.");
      expect(await error(message(p.id, grandchild.id))).toBe("Subagents can only message their own direct children.");
      expect(await error(message(grandchild.id, sibling.id))).toBe("Subagents can only message their own direct children.");
      expect(await error(h.runtime.execute({ abort: child.id }, grandchild.id))).toBe("Subagents can only abort their own direct children.");
      expect(await error(h.runtime.execute({ abort: grandchild.id }, sibling.id))).toBe("Subagents can only abort their own direct children.");
      expect((await message(grandchild.id, child.id)).isError).toBe(false);
      expect((await h.runtime.execute({ abort: grandchild.id }, child.id)).isError).toBe(false);
    });

    test("aborting a child aborts its running subagents too", async () => {
      const h = harness({ runTurn: () => new Promise(() => {}) });
      const p = parent();
      const child = await spawn(h.runtime, p.id);
      const grandchild = await spawn(h.runtime, child.id);
      const controllers = new Map([child.id, grandchild.id].map(id => [id, new AbortController()]));
      for (const [id, controller] of controllers) conversations.setActiveJob(id, controller, Date.now());
      const response = JSON.parse((await h.runtime.execute({ abort: child.id }, p.id)).output);
      expect(response).toEqual({ conversation_id: child.id, status: "aborted", aborted_subagents: [grandchild.id] });
      expect(controllers.get(child.id)!.signal.aborted).toBe(true);
      expect(controllers.get(grandchild.id)!.signal.aborted).toBe(true);
    });

    test("an aborted subagent does not start again from automated input already queued for it", async () => {
      const { beginPendingSubagentNotification, settlePendingSubagentNotifications, listPendingSubagentNotifications, removePendingSubagentNotificationsForConversation } = await import("../subagent-notifications");
      const h = harness({ runTurn: () => new Promise(() => {}) });
      const p = parent();
      const child = await spawn(h.runtime, p.id);
      const controller = new AbortController();
      conversations.setActiveJob(child.id, controller, Date.now());
      // Queued while it streamed: the parent's after_turn message, a finished
      // grandchild's result, and something the user typed into it.
      conversations.pushQueuedMessage(child.id, "also do X", "message-end", undefined, null, undefined, undefined, undefined,
        { kind: "exo_send", sourceId: p.id });
      conversations.pushQueuedMessage(child.id, "[notification] Subagent completed", "next-turn", undefined, null, "gc-note", undefined, undefined,
        { kind: "subagent_completion", sourceId: "gc" });
      conversations.pushQueuedMessage(child.id, "typed by the user", "message-end");
      beginPendingSubagentNotification({ convId: child.id }, "late-grandchild", "task", 1, 0);
      settlePendingSubagentNotifications("late-grandchild", { ok: true, blocks: [] });
      try {
        expect((await h.runtime.execute({ abort: child.id }, p.id)).isError).toBe(false);
        expect(controller.signal.aborted).toBe(true);
        expect(conversations.getQueuedMessages(child.id).map(entry => entry.text)).toEqual(["typed by the user"]);
        expect(listPendingSubagentNotifications({ childConvId: "late-grandchild" })).toEqual([]);
      } finally {
        removePendingSubagentNotificationsForConversation("late-grandchild");
        conversations.clearQueuedMessages(child.id);
        conversations.clearActiveJob(child.id);
      }
    });

    test("no subagent at any depth can restart the daemon", async () => {
      const schedule = mock(() => "unit");
      const h = harness({ restart: { startedAt: Date.now() - RESTART_MIN_UPTIME_MS - 60_000, target: "service", schedule } });
      const child = await spawn(h.runtime, parent().id);
      const grandchild = await spawn(h.runtime, child.id);
      for (const id of [child.id, grandchild.id]) {
        expect(await error(h.runtime.execute({ restart: "" }, id))).toBe("Subagents cannot restart the daemon; ask the parent conversation.");
      }
      expect(schedule).not.toHaveBeenCalled();
    });
  });
  test("abort targets exactly one conversation and rejects self/missing targets", async () => {
    const h = harness();
    const p = parent();
    const target = parent();
    const controller = new AbortController();
    conversations.setActiveJob(target.id, controller, Date.now());
    expect((await h.runtime.execute({ abort: target.id }, p.id)).isError).toBe(false);
    expect(controller.signal.aborted).toBe(true);
    expect((await h.runtime.execute({ abort: p.id }, p.id)).isError).toBe(true);
    expect((await h.runtime.execute({ abort: "missing" }, p.id)).isError).toBe(true);
    expect((await h.runtime.execute({ abort: " " }, p.id)).isError).toBe(true);
  });
  describe("message and status", () => {
    const queued = (convId: string) => conversations.getQueuedMessages(convId);
    afterEach(() => { for (const id of ids) for (const entry of queued(id)) conversations.removeQueuedMessageById(entry.id); });

    test("refuses the caller's own conversation, missing targets, blank fields, and subagents' non-children", async () => {
      const h = harness();
      const p = parent();
      const other = parent();
      const send = (input: unknown, caller = p.id) => h.runtime.execute({ message: input }, caller);
      const own = await send({ conversation: p.id, text: "hi" });
      expect(own.isError).toBe(true);
      expect(JSON.parse(own.output).error).toBe("Cannot message the conversation currently executing this tool.");
      expect(JSON.parse((await send({ conversation: "missing", text: "hi" })).output).error).toBe("Conversation missing not found");
      expect((await send({ conversation: " ", text: "hi" })).isError).toBe(true);
      expect((await send({ conversation: other.id, text: " " })).isError).toBe(true);
      expect((await h.runtime.execute({ message: { conversation: other.id, text: "hi" } }, undefined)).isError).toBe(true);
      const child = await spawn(h.runtime, p.id);
      expect((await send({ conversation: other.id, text: "hi" }, child.id)).isError).toBe(true);
      expect((await send({ conversation: p.id, text: "hi" }, child.id)).isError).toBe(true);
      await settle();
      expect(h.runTurn).toHaveBeenCalledTimes(1);
      expect(queued(other.id)).toEqual([]);
    });

    test("a streaming target gets a durable automated queue entry and is steered", async () => {
      const h = harness();
      const p = parent();
      const target = parent();
      conversations.setActiveJob(target.id, new AbortController(), Date.now());
      const steer = mock(() => {});
      conversations.setActiveSteerHandler(target.id, steer);
      try {
        const now = await h.runtime.execute({ message: { conversation: target.id, text: " new info " } }, p.id);
        expect(now.isError).toBe(false);
        const body = JSON.parse(now.output);
        expect(body).toMatchObject({ conversation_id: target.id, status: "queued", target_status: "streaming" });
        expect(body.delivers).toContain("next tool boundary");
        expect(queued(target.id)).toMatchObject([{
          id: body.queue_id, text: "new info", timing: "next-turn", automation: { kind: "exo_send", sourceId: p.id },
        }]);
        expect(steer).toHaveBeenCalledTimes(1);
        const later = await h.runtime.execute({ message: { conversation: target.id, text: "after", delivery: "after_turn" } }, p.id);
        expect(JSON.parse(later.output).delivers).toContain("after the active one ends");
        expect(queued(target.id).map(entry => entry.timing)).toEqual(["next-turn", "message-end"]);
        expect(steer).toHaveBeenCalledTimes(1);
        expect(h.runTurn).not.toHaveBeenCalled();
        const status = JSON.parse((await h.runtime.execute({ status: target.id }, p.id)).output);
        expect(status).toMatchObject({ conversation_id: target.id, title: "parent", status: "streaming", queued_messages: 2 });
        expect(typeof status.streaming_since).toBe("string");
      } finally { conversations.clearActiveSteerHandler(target.id, steer); }
    });

    test("an idle child starts a turn now, is tracked again, and reports its reply to the caller", async () => {
      let resolve!: (value: typeof outcome) => void;
      const p = parent();
      const h = harness();
      const child = await spawn(h.runtime, p.id);
      await settle();
      h.runTurn.mockImplementation(() => new Promise(res => { resolve = res; }));
      const response = await h.runtime.execute({ message: { conversation: child.id, text: "follow up", delivery: "after_turn" } }, p.id);
      expect(JSON.parse(response.output)).toMatchObject({ conversation_id: child.id, status: "delivered", target_status: "idle" });
      expect(h.runTurn).toHaveBeenCalledTimes(2);
      expect((h.runTurn.mock.calls[1] as unknown[]).slice(0, 3)).toEqual([child.id, "follow up", 1]);
      expect((h.runTurn.mock.calls[1] as unknown[])[4]).toEqual({ kind: "exo_send", sourceId: p.id });
      expect(h.beginParentNotification.mock.calls[1] as unknown[]).toEqual([{ convId: p.id }, child.id, "follow up", expect.any(Number), 1, true]);
      expect(getConversationActivityCounts(p.id).subagentCount).toBe(1);
      expect(queued(child.id)).toEqual([]);
      resolve(outcome);
      await settle();
      expect(h.completeParentNotification).toHaveBeenCalledTimes(2);
      expect(getConversationActivityCounts(p.id).subagentCount).toBe(0);
      expect(JSON.parse((await h.runtime.execute({ status: child.id }, p.id)).output)).toMatchObject({ status: "idle", queued_messages: 0 });
    });

    test("an idle non-child is not tracked as a subagent; signed-out providers are refused", async () => {
      const p = parent();
      const other = parent("anthropic");
      const h = harness();
      expect((await h.runtime.execute({ message: { conversation: other.id, text: "question" } }, p.id)).isError).toBe(false);
      expect((h.beginParentNotification.mock.calls[0] as unknown[])[5]).toBe(false);
      expect(getConversationActivityCounts(p.id).subagentCount).toBe(0);
      await settle();
      expect(h.completeParentNotification).toHaveBeenCalledTimes(1);
      const signedOut = harness({ hasCredentials: provider => provider !== "anthropic" });
      const refused = await signedOut.runtime.execute({ message: { conversation: other.id, text: "question" } }, p.id);
      expect(JSON.parse(refused.output).error).toBe("Not authenticated for provider anthropic");
      expect(signedOut.runTurn).not.toHaveBeenCalled();
      expect((await h.runtime.execute({ status: "missing" }, p.id)).isError).toBe(true);
    });
  });
  test("startup failure clears tracking and notifies once; unavailable provider creates no child", async () => {
    const p = parent();
    const h = harness({ runTurn: () => { throw new Error("startup failed"); } });
    await spawn(h.runtime, p.id);
    await settle();
    expect(getConversationActivityCounts(p.id).subagentCount).toBe(0);
    expect(h.completeParentNotification).toHaveBeenCalledTimes(1);
    const blocked = harness({ hasCredentials: () => false });
    expect((await blocked.runtime.execute({ subagent: "task" }, p.id)).isError).toBe(true);
    expect(blocked.runTurn).not.toHaveBeenCalled();
  });
  test("parent capacity and pre-aborted calls fail before starting more work", async () => {
    const p = parent();
    const h = harness();
    for (let i = 0; i < MAX_ACTIVE_EXO_SUBAGENTS_PER_PARENT; i++) {
      setSubagentActive(p.id, `capacity-${i}`, true, { title: "busy", startedAt: Date.now() });
    }
    expect((await h.runtime.execute({ subagent: "another task" }, p.id)).isError).toBe(true);
    expect(h.runTurn).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(h.runtime.execute({ subagent: "cancelled" }, p.id, controller.signal)).rejects.toThrow("Aborted");
  });
  test("default notification fallback is delivered once, including failure", async () => {
    const p = parent();
    const h = harness({ beginParentNotification: undefined, completeParentNotification: undefined });
    await spawn(h.runtime, p.id, { detach: false });
    await settle();
    expect(h.notifyParent).toHaveBeenCalledTimes(1);
    const failing = harness({ completeParentNotification: undefined, runTurn: async () => ({ ...outcome, ok: false, error: "failed" }) });
    await spawn(failing.runtime, p.id);
    await settle();
    expect(failing.notifyParent).toHaveBeenCalledTimes(1);
    expect(failing.notifyParent.mock.calls[0]).toHaveLength(4);
  });
  test("aborting a goal pauses its continuation, and a child cannot abort its parent", async () => {
    const p = parent();
    const h = harness();
    const target = parent();
    conversations.setGoal(target.id, "goal to interrupt");
    const controller = new AbortController();
    conversations.setActiveJob(target.id, controller, Date.now());
    expect((await h.runtime.execute({ abort: target.id }, p.id)).isError).toBe(false);
    expect(controller.signal.aborted).toBe(true);
    expect(target.goal?.status).toBe("paused");
    const child = await spawn(h.runtime, p.id);
    expect((await h.runtime.execute({ abort: p.id }, child.id)).isError).toBe(true);
  });
  describe("restart", () => {
    afterEach(() => resetRequestedRestartForTest());
    const restartOptions = (startedAgoMs: number) => {
      const schedule = mock((token: string) => `unit-${token}`);
      return { schedule, restart: { startedAt: Date.now() - startedAgoMs, target: "service" as const, schedule } };
    };

    test("schedules an after-turn restart for the calling conversation", async () => {
      const p = parent();
      const { schedule, restart } = restartOptions(RESTART_MIN_UPTIME_MS + 60_000);
      const response = await harness({ restart }).runtime.execute({ restart: "deploy merged fix" }, p.id);
      expect(response.isError).toBe(false);
      const body = JSON.parse(response.output);
      expect(body).toMatchObject({ status: "scheduled", reason: "deploy merged fix", runs: "after this turn ends" });
      expect(schedule).toHaveBeenCalledWith(body.token);
      expect(readRequestedRestart()).toMatchObject({ token: body.token, requestedBy: p.id, state: "scheduled" });
    });

    test("cooldown and already-pending requests are refused with clear messages", async () => {
      const p = parent();
      const fresh = restartOptions(30_000);
      const early = await harness({ restart: fresh.restart }).runtime.execute({ restart: "" }, p.id);
      expect(early.isError).toBe(true);
      expect(JSON.parse(early.output).error).toMatch(/Refusing restart: the daemon started 0m 30s ago/);
      expect(fresh.schedule).not.toHaveBeenCalled();

      const ok = restartOptions(RESTART_MIN_UPTIME_MS + 60_000);
      expect((await harness({ restart: ok.restart }).runtime.execute({ restart: "" }, p.id)).isError).toBe(false);
      const again = await harness({ restart: ok.restart }).runtime.execute({ restart: "" }, parent().id);
      expect(again.isError).toBe(true);
      expect(JSON.parse(again.output).error).toMatch(/already pending/);
      expect(ok.schedule).toHaveBeenCalledTimes(1);
    });

    test("subagents and depth-zero turns cannot restart the daemon", async () => {
      const p = parent();
      const { schedule, restart } = restartOptions(RESTART_MIN_UPTIME_MS + 60_000);
      const h = harness({ restart });
      const child = await spawn(h.runtime, p.id);
      expect((await h.runtime.execute({ restart: "" }, child.id)).isError).toBe(true);
      expect((await h.runtime.execute({ restart: "" }, p.id, undefined, 0)).isError).toBe(true);
      expect((await h.runtime.execute({ restart: "" }, undefined)).isError).toBe(true);
      expect(schedule).not.toHaveBeenCalled();
    });
  });
});
