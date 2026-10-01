import { afterEach, describe, expect, mock, test } from "bun:test";
import { clearConversationDefaults, saveConversationDefaults } from "@exocortex/shared/config";
import { createExocortexToolRuntime, type ExocortexToolRuntimeDependencies } from "../exocortex-tool-runtime";
import * as conversations from "../conversations";
import { getConversationActivityCounts, resetConversationActivityForTest, setSubagentActive } from "../conversation-activity";
import { buildConversationRequestSurface } from "../conversation-request-surface";
import { setLoadedExternalToolsForTest } from "../external-tools";
import { latestSizeModel } from "../delegation-models";
import { getProvider } from "../providers/registry";
import { MAX_ACTIVE_EXO_SUBAGENTS_PER_PARENT } from "../messages";
import { exo } from "./exo";

const ids = new Set<string>();
function parent() {
  const id = `simple-exo-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  ids.add(id);
  return conversations.create(id, "openai", "gpt-6-astra", "parent");
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
  test("schema exposes only subagent/args/abort with two model choices", () => {
    const properties = exo.inputSchema.properties as Record<string, any>;
    expect(Object.keys(properties)).toEqual(["subagent", "args", "abort"]);
    expect(Object.keys(properties.args.properties)).toEqual(["detach", "model"]);
    expect(properties.args.properties.model.enum).toEqual(["sol fast", "astra"]);
    expect(exo.systemHint).toContain("Almost never use subagents");
    expect(exo.systemHint).toContain("shared/src/protocol.ts");
  });
  test("Sol fast is the default independently of user defaults; Astra is the only override", async () => {
    saveConversationDefaults({ provider: "openai", model: "gpt-6-astra", effort: "high", fastMode: false });
    const p = parent();
    const h = harness();
    const sol = await spawn(h.runtime, p.id);
    expect(sol.model).toBe(latestSizeModel("sol", getProvider("openai")!.models.map(model => model.id))!);
    expect(sol.fastMode).toBe(true);
    expect(sol.subagentMaxDepth).toBe(0);
    expect(sol.toolPolicy).toBeFalsy();
    const astra = await spawn(h.runtime, p.id, { model: "astra" });
    expect(astra.model).toBe(latestSizeModel("astra", getProvider("openai")!.models.map(model => model.id))!);
    expect(astra.fastMode).toBe(false);
    await settle();
    expect(h.beginParentNotification).toHaveBeenCalledTimes(2);
    expect(h.completeParentNotification).toHaveBeenCalledTimes(2);
    expect(getConversationActivityCounts(p.id).subagentCount).toBe(0);
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
      { subagent: "do it", args: { model: "gpt-6-astra" } }, { subagent: "do it", args: { detach: "yes" } },
    ]) expect((await h.runtime.execute(input, p.id)).isError).toBe(true);
    expect(h.runTurn).not.toHaveBeenCalled();
    expect(getConversationActivityCounts(p.id).subagentCount).toBe(0);
  });
  test("children and depth-zero turns cannot delegate", async () => {
    const h = harness();
    const p = parent();
    const child = await spawn(h.runtime, p.id);
    expect((await h.runtime.execute({ subagent: "nested" }, child.id)).isError).toBe(true);
    expect((await h.runtime.execute({ subagent: "nested" }, p.id, undefined, 0)).isError).toBe(true);
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
});
