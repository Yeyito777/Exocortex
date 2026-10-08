import { expect, test } from "bun:test";
import { ConversationPrewarmer, type PrewarmContext } from "./prewarm";

const context: PrewarmContext = { convId: null, provider: "openai", model: "test", effort: "high", fastMode: true, eligible: true };

test("blank draft prewarms immediately without a persisted conversation and sends with the same reserved ID", () => {
  const sent: unknown[] = [];
  const controller = new ConversationPrewarmer((id, draft) => sent.push([id, draft]), () => "reserved");
  controller.observe(context);
  controller.observe(context);
  expect(sent).toEqual([["reserved", true]]);
  expect(controller.takeDraftId()).toBe("reserved");
  expect(controller.takeDraftId()).toBeNull();
});

test("opening existing conversations and changing selection prewarms without waiting for typing", () => {
  let now = 0;
  const sent: unknown[] = [];
  const controller = new ConversationPrewarmer((id, draft) => sent.push([id, draft]), () => "unused", () => now);
  controller.observe({ ...context, convId: "existing" });
  controller.observe({ ...context, convId: "existing" });
  controller.observe({ ...context, convId: "existing", effort: "low" });
  now = 30_001;
  controller.observe({ ...context, convId: "existing", effort: "low" });
  expect(sent).toEqual([["existing", false], ["existing", false], ["existing", false]]);
});

test("unauthenticated, streaming, document and non-OpenAI views do not open transports; resets reserve fresh draft IDs", () => {
  let serial = 0;
  const sent: unknown[] = [];
  const controller = new ConversationPrewarmer((id, draft) => sent.push([id, draft]), () => `id-${++serial}`);
  controller.observe({ ...context, eligible: false });
  controller.observe({ ...context, provider: "deepseek" });
  expect(sent).toEqual([]);
  controller.observe(context);
  controller.reset();
  controller.observe(context);
  expect(sent).toEqual([["id-1", true], ["id-2", true]]);
});
