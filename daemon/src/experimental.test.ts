import { afterEach, describe, expect, mock, test } from "bun:test";
import { writeExocortexConfig } from "@exocortex/shared/config";
import { experimentalFeatures, resetExperimentalFeaturesForTest } from "./experimental";
import { buildExecutor, getToolDefs, getToolDisplayInfo } from "./tools/registry";
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

describe("experimental.images", () => {
  test("is off by default: no attach tool for any provider, get_image refuses", async () => {
    useConfig({});
    expect(experimentalFeatures()).toEqual({ images: false });
    expect(getToolDefs().map(tool => tool.name)).not.toContain("attach");
    expect(getToolDefs(undefined).map(tool => tool.name)).not.toContain("attach");
    expect(getToolDisplayInfo().some(tool => tool.name === "attach")).toBe(false);
    expect(hostToolDefs(getToolDefs()).map(def => def.name)).not.toContain("attach");
    const [result] = await buildExecutor({})([{ id: "c1", name: "attach", input: { paths: ["x.png"] } }]);
    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain("attach");

    const { sent, handle } = harness();
    await handle({} as never, { type: "get_image", reqId: "r", imageId: "a".repeat(64), format: "png", width: 10, height: 10 });
    expect(sent).toEqual([{ type: "error", reqId: "r", message: expect.stringContaining("inline images are disabled") }]);
    await handle({} as never, { type: "ping", reqId: "boot" });
    expect(sent.find(event => event.type === "tools_available")?.experimental).toEqual({ images: false });
  });

  test("when on, attach is offered natively and to Claude Code, and the bootstrap says so", async () => {
    useConfig({ experimental: { images: true } });
    expect(getToolDefs().map(tool => tool.name)).toContain("attach");
    expect(hostToolDefs(getToolDefs()).map(def => def.name)).toContain("attach");
    const { sent, handle } = harness();
    await handle({} as never, { type: "ping", reqId: "boot" });
    expect(sent.find(event => event.type === "tools_available")?.experimental).toEqual({ images: true });
  });

  test("is read once per process: a config change needs a restart", () => {
    useConfig({ experimental: { images: true } });
    expect(experimentalFeatures().images).toBe(true);
    writeExocortexConfig({});
    expect(experimentalFeatures().images).toBe(true);
    resetExperimentalFeaturesForTest();
    expect(experimentalFeatures().images).toBe(false);
  });
});
