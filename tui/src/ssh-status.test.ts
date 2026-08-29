import { describe, expect, test } from "bun:test";
import { handleEvent } from "./events";
import { createInitialState } from "./state";

const daemon = {
  subscribe() {},
  unsubscribe() {},
  sendMessage() {},
  setSystemInstructions() {},
  loadToolOutputs() {},
};

describe("SSH status events", () => {
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
      authByProvider: { openai: true, deepseek: false, opencode: false },
      authInfoByProvider: state.authInfoByProvider,
    }, state, daemon);

    expect(String(state.provider)).toBe("openai");
    expect(state.model).toBe("remote-model");
  });
});
