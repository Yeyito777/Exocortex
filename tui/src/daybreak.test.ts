import { expect, test } from "bun:test";
import { DAYBREAK_RETIRED_MODEL, DAYBREAK_UNAVAILABLE } from "@exocortex/shared/daybreak";
import { tryCommand } from "./commands";
import { createInitialState, newConversationSelection, resetNewConversationDefaults } from "./state";
import { handleConversationUpdated } from "./events/conversations";

function fixture(cyber: string[] | null = ["standard", "daybreak_blue"]) {
  const state = createInitialState();
  state.providerRegistry = [{
    id: "openai", label: "OpenAI", defaultModel: "gpt-6-sol",
    allowsCustomModels: true, supportsFastMode: true,
    models: ["gpt-6-sol", "gpt-6-luna", "gpt-6-astra"].map(id => ({
      id, label: id, maxContext: 272_000, defaultEffort: "max",
      supportedEfforts: [{ effort: "max", description: "Maximum reasoning" }],
      supportsDaybreak: id === "gpt-6-sol" && (cyber?.includes("daybreak_blue") ?? false),
    })),
  }];
  state.provider = "openai";
  state.model = "gpt-6-sol";
  state.hasChosenProvider = true;
  state.fastMode = true;
  state.effort = "max";
  return state;
}

test("draft Daybreak toggle preserves model, effort and speed, and is captured for creation", () => {
  const state = fixture();
  expect(tryCommand("/daybreak on", state)).toEqual({ type: "handled" });
  expect(newConversationSelection(state)).toMatchObject({
    provider: "openai", model: "gpt-6-sol", effort: "max", fastMode: true, daybreak: true,
  });
  tryCommand("/daybreak", state);
  expect(state.daybreak).toBe(false);
  tryCommand("/daybreak", state);
  expect(state.daybreak).toBe(true);
  resetNewConversationDefaults(state);
  expect(state.daybreak).toBe(false);
});

test("connected conversations wait for authoritative daemon confirmation", () => {
  const state = fixture();
  state.convId = "daybreak-conversation";
  expect(tryCommand("/daybreak on", state)).toEqual({ type: "daybreak_changed", enabled: true });
  expect(state.daybreak).toBe(false);
  handleConversationUpdated({
    type: "conversation_updated",
    summary: {
      id: state.convId, provider: "openai", model: state.model, effort: "max", fastMode: true, daybreak: true,
      title: "", createdAt: 1, updatedAt: 1, messageCount: 0, marked: false,
      pinned: false, sortOrder: 0, streaming: false, unread: false, subagentCount: 0, backgroundTaskCount: 0,
    },
  }, state);
  expect(state.daybreak).toBe(true);
  expect(tryCommand("/daybreak off", state)).toEqual({ type: "daybreak_changed", enabled: false });
});

test("missing/empty/red-only metadata, other models and providers cannot enable Daybreak", () => {
  for (const cyber of [null, [], ["standard"], ["daybreak_red"]]) {
    const state = fixture(cyber);
    tryCommand("/daybreak on", state);
    expect(state.daybreak).toBe(false);
    expect(state.messages.at(-1)).toMatchObject({ text: DAYBREAK_UNAVAILABLE });
  }
  for (const model of ["gpt-6-luna", "gpt-6-astra", "custom-sol"]) {
    const state = fixture();
    state.model = model;
    tryCommand("/daybreak on", state);
    expect(state.daybreak).toBe(false);
  }
  const state = fixture();
  state.provider = "deepseek";
  tryCommand("/daybreak on", state);
  expect(state.daybreak).toBe(false);
  // Even after discovery/auth disappears, off remains available.
  state.daybreak = true;
  tryCommand("/daybreak off", state);
  expect(state.daybreak).toBe(false);
});

test("invalid arguments are non-mutating and switching away reports Daybreak off", () => {
  const state = fixture();
  for (const command of ["/daybreak yes", "/daybreak on off"]) {
    tryCommand(command, state);
    expect(state.daybreak).toBe(false);
    expect(state.messages.at(-1)).toMatchObject({ text: "Usage: /daybreak [on|off]" });
  }
  state.daybreak = true;
  tryCommand("/model openai gpt-6-luna", state);
  expect(state.daybreak).toBe(false);
  expect(state.fastMode).toBe(true);
  expect(state.messages.at(-1)).toMatchObject({ text: expect.stringContaining("(daybreak off)") });
});

test("the old model slug cannot silently become a custom model selection", () => {
  const state = fixture();
  tryCommand("/model openai gpt-daybreak-blue-latest", state);
  expect(state.model).toBe("gpt-6-sol");
  expect(state.messages.at(-1)).toMatchObject({ text: DAYBREAK_RETIRED_MODEL });
});
