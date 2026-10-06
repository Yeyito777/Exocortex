import { expect, test } from "bun:test";
import { DAYBREAK_MODEL_ID, DAYBREAK_RETIRED_MODEL, DAYBREAK_UNAVAILABLE } from "@exocortex/shared/daybreak";
import { tryCommand, getCommandArgs, COMMAND_LIST } from "./commands";
import { createInitialState, newConversationSelection } from "./state";
import { previewInlineCommands } from "./inlineeffort";

function fixture(entitled = true) {
  const state = createInitialState();
  state.providerRegistry = [{
    id: "openai", label: "OpenAI", defaultModel: "gpt-6-sol",
    allowsCustomModels: true, supportsFastMode: true,
    models: ["gpt-6-sol", ...(entitled ? [DAYBREAK_MODEL_ID] : [])].map(id => ({
      id, label: id, maxContext: 272_000, defaultEffort: "medium",
      supportedEfforts: [{ effort: "max", description: "Maximum reasoning" }, { effort: "medium", description: "Medium" }],
    })),
  }];
  state.provider = "openai";
  state.model = "gpt-6-sol";
  state.hasChosenProvider = true;
  state.fastMode = true;
  state.effort = "max";
  return state;
}

test("Daybreak is a normal model selection with independent effort and speed", () => {
  const state = fixture();
  expect(tryCommand(`/model openai ${DAYBREAK_MODEL_ID}`, state)).toEqual({ type: "handled" });
  expect(newConversationSelection(state)).toEqual({
    provider: "openai", model: DAYBREAK_MODEL_ID, effort: "max", fastMode: true,
  });
  state.convId = "daybreak-conversation";
  expect(tryCommand("/model openai gpt-6-sol", state)).toEqual({ type: "model_changed", provider: "openai", model: "gpt-6-sol" });
  expect(state.effort).toBe("max");
  expect(state.fastMode).toBe(true);
});

test("alias appears in model completion only when discovered, with no toggle command", () => {
  expect(getCommandArgs(fixture())["/model openai"]?.some(item => item.name === DAYBREAK_MODEL_ID)).toBe(true);
  expect(getCommandArgs(fixture(false))["/model openai"]?.some(item => item.name === DAYBREAK_MODEL_ID)).toBe(false);
  expect(COMMAND_LIST.some(item => item.name === "/daybreak")).toBe(false);
});

test("missing entitlement cannot silently become a custom-model selection", () => {
  const state = fixture(false);
  tryCommand(`/model openai ${DAYBREAK_MODEL_ID}`, state);
  expect(state.model).toBe("gpt-6-sol");
  expect(state.messages.at(-1)).toMatchObject({ text: DAYBREAK_UNAVAILABLE });
});

test("unsupported and retired Daybreak ids are non-mutating", () => {
  for (const model of ["gpt-daybreak-blue-latest", "gpt-6.1-sol-daybreak", "gpt-6-luna-daybreak"]) {
    const state = fixture();
    tryCommand(`/model openai ${model}`, state);
    expect(state.model).toBe("gpt-6-sol");
    expect(state.messages.at(-1)).toMatchObject({ text: DAYBREAK_RETIRED_MODEL });
  }
});

test("inline model selection uses the same alias and preserves the surrounding prompt", () => {
  const state = fixture();
  const result = previewInlineCommands(`/model openai ${DAYBREAK_MODEL_ID} hello`, state);
  expect(result.text).toBe("hello");
  expect(result.modelSelection).toEqual({ provider: "openai", model: DAYBREAK_MODEL_ID, effort: "max", fastMode: true });
  expect(state.model).toBe("gpt-6-sol");
});

test("Daybreak can be selected as the default using the normal default-model command", () => {
  const state = fixture();
  expect(tryCommand(`/default-model openai ${DAYBREAK_MODEL_ID} max fast`, state)).toMatchObject({
    type: "conversation_defaults_changed",
    defaults: { provider: "openai", model: DAYBREAK_MODEL_ID, effort: "max", fastMode: true },
  });
});
