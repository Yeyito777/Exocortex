import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearConversationDefaults, configuredConversationDefaults, productConversationDefaults,
  readExocortexConfig, writeExocortexConfig,
} from "@exocortex/shared/config";
import {
  conversationDefaultsSnapshot, resetDaemonConversationDefaults, setDaemonConversationDefaults,
} from "./conversation-defaults";

describe("daemon-owned conversation defaults", () => {
  beforeEach(clearConversationDefaults);
  afterEach(clearConversationDefaults);
  const defaults = { provider: "deepseek", model: "deepseek-v4-pro", effort: "max", fastMode: false } as const;

  test("persists validated defaults and returns them on subsequent snapshots", () => {
    expect(conversationDefaultsSnapshot()).toEqual({ defaults: productConversationDefaults(), configured: false });
    expect(setDaemonConversationDefaults({ ...defaults, ignored: "not persisted" })).toEqual({ defaults, configured: true });
    expect(configuredConversationDefaults()).toEqual(defaults);
    expect(readExocortexConfig().defaults?.conversation).toEqual(defaults);
    expect(conversationDefaultsSnapshot()).toEqual({ defaults, configured: true });
  });

  test("reset preserves unrelated host configuration", () => {
    const config = readExocortexConfig();
    config.defaults = { ...config.defaults, futureDefault: "keep" };
    config.audio = { ...config.audio, micGainDb: -7 };
    writeExocortexConfig(config);
    setDaemonConversationDefaults(defaults);
    expect(resetDaemonConversationDefaults()).toEqual({ defaults: productConversationDefaults(), configured: false });
    expect(readExocortexConfig().defaults?.futureDefault).toBe("keep");
    expect(readExocortexConfig().audio?.micGainDb).toBe(-7);
  });

  test.each([
    null, [], {}, { ...defaults, provider: "missing" }, { ...defaults, model: "" },
    { ...defaults, model: " spaced " }, { ...defaults, effort: "not-an-effort" },
    { ...defaults, effort: "low" }, { ...defaults, fastMode: true },
    { ...defaults, fastMode: "yes" }, { ...defaults, fastMode: "ultrafast" },
    { provider: "openrouter", model: "unlisted", effort: "none", fastMode: false },
    { provider: "openai", model: "gpt-6-astra", effort: "low", fastMode: "ultrafast" },
  ].map(value => [value]))("rejects invalid/unsupported defaults without changing persistence: %j", value => {
    setDaemonConversationDefaults(defaults);
    expect(() => setDaemonConversationDefaults(value)).toThrow();
    expect(configuredConversationDefaults()).toEqual(defaults);
  });

  test("allows provider-supported custom model ids with schema-valid effort", () => {
    const custom = { provider: "openai", model: "custom-model", effort: "high", fastMode: false } as const;
    expect(setDaemonConversationDefaults(custom)).toEqual({ configured: true, defaults: custom });
  });
});
