import { afterEach, describe, expect, test } from "bun:test";
import { handleEvent } from "./events";
import { createInitialState } from "./state";
import { clearConversationDefaults, productConversationDefaults, saveConversationDefaults } from "@exocortex/shared/config";

const daemon = {
  subscribe() {},
  unsubscribe() {},
  sendMessage() {},
  setSystemInstructions() {},
  loadToolOutputs() {},
};

describe("SSH status events", () => {
  afterEach(clearConversationDefaults);
  test("uses each endpoint's bootstrap defaults, even when both expose the same provider", () => {
    const state = createInitialState();
    saveConversationDefaults({ provider: "openai", model: "local-file-only", effort: "high", fastMode: true });
    const local = { configured: false, defaults: productConversationDefaults() };
    const remote = {
      configured: true,
      defaults: { provider: "openai", model: "remote-model", effort: "medium", fastMode: true },
    } as const;
    const bootstrap = (snapshot: typeof local | typeof remote) => handleEvent({
      type: "tools_available", providers: [], tools: [],
      authByProvider: state.authByProvider, authInfoByProvider: state.authInfoByProvider,
      conversationDefaults: snapshot,
    }, state, daemon);
    bootstrap(local);
    expect(state.conversationDefaults).toEqual(local);
    for (const [mode, alias, snapshot] of [
      ["remote", "whale", remote], ["local", undefined, local],
    ] as const) {
      handleEvent({
        type: "ssh_status", mode, alias, state: "connected", switched: true, message: "Switched",
      }, state, daemon);
      expect(state.conversationDefaults).toBeNull();
      // main.ts resets the draft on an endpoint switch, before releasing bootstrap.
      state.hasChosenProvider = false;
      bootstrap(snapshot);
      expect(state.conversationDefaults).toEqual(snapshot);
      expect(state.model).toBe(snapshot.defaults.model);
      expect(state.fastMode).toBe(snapshot.defaults.fastMode);
    }
  });

  test("a defaults mutation acknowledgement updates a draft but not a focused chat", () => {
    const state = createInitialState();
    const event = {
      type: "conversation_defaults", configured: true, message: "Default model saved",
      defaults: { provider: "deepseek", model: "deepseek-v4-pro", effort: "max", fastMode: false },
    } as const;
    state.hasChosenProvider = true;
    state.model = "edited-draft";
    handleEvent(event, state, daemon);
    expect(state.model).toBe("deepseek-v4-pro");
    expect(JSON.stringify(state.messages)).toContain("Default model saved");
    state.convId = "focused";
    state.model = "focused-model";
    handleEvent(event, state, daemon);
    expect(state.model).toBe("focused-model");
  });

  test("bootstrap preserves the daemon's effort for an allowed custom model", () => {
    const state = createInitialState();
    handleEvent({
      type: "tools_available",
      providers: [{
        id: "openai", label: "OpenAI", defaultModel: "catalog-default",
        allowsCustomModels: true, supportsFastMode: true, models: [],
      }],
      tools: [], authByProvider: state.authByProvider, authInfoByProvider: state.authInfoByProvider,
      conversationDefaults: {
        configured: true,
        defaults: { provider: "openai", model: "custom-model", effort: "low", fastMode: true },
      },
    }, state, daemon);
    expect(state.model).toBe("custom-model");
    expect(state.effort).toBe("low");
    expect(state.fastMode).toBe(true);
  });

  test("keeps progress through local startup loads and remote transport activation until bootstrap", () => {
    const state = createInitialState();
    handleEvent({
      type: "ssh_status", mode: "local", state: "switching", switched: false,
      message: "Connecting through SSH alias whale…",
    }, state, daemon);
    // Local startup data can replace the transcript while the probe is running.
    state.messages = [];
    handleEvent({ type: "conversations_list", conversations: [] }, state, daemon);
    expect(state.sshConnecting).toEqual({ phase: "probing", message: "Connecting through SSH alias whale…" });

    handleEvent({
      type: "ssh_status", mode: "remote", alias: "whale", state: "connected",
      switched: true, message: "Connected daemon: SSH alias whale.",
    }, state, daemon);
    expect(state.sshConnecting?.phase).toBe("loading");
    handleEvent({
      type: "ssh_status", mode: "remote", alias: "whale", state: "connected",
      switched: false, silent: true, message: "Connected daemon: SSH alias whale.",
    }, state, daemon);
    expect(state.sshConnecting?.phase).toBe("loading");
    handleEvent({ type: "conversations_list", conversations: [] }, state, daemon);
    expect(state.sshConnecting).toBeNull();
  });

  test.each(["failed", "connected"] as const)("clears probe progress on %s (failure or cancellation)", status => {
    const state = createInitialState();
    handleEvent({
      type: "ssh_status", mode: "local", state: "switching", switched: false,
      message: "Connecting through SSH alias whale…",
    }, state, daemon);
    handleEvent({
      type: "ssh_status", mode: "local", state: status, switched: false,
      message: "Returned to local daemon.",
    }, state, daemon);
    expect(state.sshConnecting).toBeNull();
  });

  test("sets and clears the remote indicator while printing daemon info", () => {
    const state = createInitialState();
    handleEvent({
      type: "ssh_status",
      mode: "remote",
      state: "connected",
      alias: "whale",
      switched: true,
      message: "Connected daemon: SSH alias whale.",
    }, state, daemon);

    expect(state.sshRemote).toEqual({ alias: "whale", connected: true });
    expect((state.messages.at(-1) as { text?: string }).text).toContain("SSH alias whale");

    handleEvent({
      type: "ssh_status",
      mode: "local",
      state: "connected",
      switched: true,
      message: "Connected daemon: local.",
    }, state, daemon);
    expect(state.sshRemote).toBeNull();
  });

  test("marks the selected route disconnected after SSH loss", () => {
    const state = createInitialState();
    state.sshRemote = { alias: "whale", connected: true };
    handleEvent({
      type: "ssh_status",
      mode: "remote",
      state: "failed",
      alias: "whale",
      switched: false,
      message: "SSH connection was lost.",
    }, state, daemon);

    expect(state.sshRemote).toEqual({ alias: "whale", connected: false });
  });

  test("restores the indicator silently after a transport reconnect", () => {
    const state = createInitialState();
    handleEvent({
      type: "ssh_status",
      mode: "remote",
      state: "connected",
      alias: "whale",
      switched: false,
      silent: true,
      message: "Connected daemon: SSH alias whale.",
    }, state, daemon);

    expect(state.sshRemote).toEqual({ alias: "whale", connected: true });
    expect(state.messages).toEqual([]);
  });

  test("adopts an available provider when the remote registry replaces the local one", () => {
    const state = createInitialState();
    state.provider = "deepseek";
    state.model = "deepseek-local";
    state.hasChosenProvider = true;

    handleEvent({
      type: "tools_available",
      providers: [{
        id: "openai",
        label: "OpenAI",
        defaultModel: "remote-model",
        allowsCustomModels: false,
        supportsFastMode: false,
        models: [{
          id: "remote-model",
          label: "Remote model",
          maxContext: 100_000,
          supportedEfforts: [{ effort: "medium", description: "Balanced" }],
          defaultEffort: "medium",
        }],
      }],
      tools: [],
      authByProvider: { openai: true, anthropic: false, deepseek: false, opencode: false, openrouter: false },
      authInfoByProvider: state.authInfoByProvider,
    }, state, daemon);

    expect(String(state.provider)).toBe("openai");
    expect(state.model).toBe("remote-model");
  });
});
