import { afterEach, describe, expect, mock, test } from "bun:test";
import { writeExocortexConfig } from "@exocortex/shared/config";
import { resetExperimentalFeaturesForTest } from "./experimental";
import { getToolDefs, getToolDisplayInfo } from "./tools/registry";
import { hostToolDefs } from "./providers/anthropic/host-tools";
import { createHandler } from "./handler";

function useConfig(config: Parameters<typeof writeExocortexConfig>[0]): void {
  writeExocortexConfig(config);
  resetExperimentalFeaturesForTest();
}

afterEach(() => useConfig({}));

function harness() {
  const sent: Array<Record<string, unknown>> = [];
  const server = {
    sendTo: mock((_client: unknown, event: Record<string, unknown>) => { sent.push(event); }),
    broadcast: mock(() => {}),
    sendToSubscribers: mock(() => {}),
    sendToSubscribersExcept: mock(() => {}),
    subscribe: mock(() => {}),
    unsubscribe: mock(() => {}),
    hasSubscribers: mock(() => false),
  };
  return { sent, handle: createHandler(server as never) };
}

describe("inline images", () => {
  test("are always on, even with the retired experimental.images flag set to false", async () => {
    useConfig({ experimental: { images: false } });
    expect(getToolDefs().map(tool => tool.name)).toContain("attach");
    expect(getToolDisplayInfo().some(tool => tool.name === "attach")).toBe(true);
    expect(hostToolDefs(getToolDefs()).map(def => def.name)).toContain("attach");

    const { sent, handle } = harness();
    await handle({} as never, { type: "get_image", reqId: "r", imageId: "a".repeat(64), format: "png", width: 10, height: 10 });
    expect(JSON.stringify(sent)).not.toContain("disabled");
    // TUIs that predate always-on images still gate on the legacy flag.
    await handle({} as never, { type: "ping", reqId: "boot" });
    expect(sent.find(event => event.type === "tools_available")?.experimental).toEqual({ images: true });
  });
});
