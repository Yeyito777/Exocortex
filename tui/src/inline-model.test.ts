import { afterEach, expect, test } from "bun:test";
import { createInitialState } from "./state";
import { clearPreferredProvider } from "./preferences";
import { applyInlineCommands, getInlineCommandArgs, previewInlineCommands } from "./inlineeffort";
import { getCommandArgs, tryCommand } from "./commands";
import { updateAutocomplete } from "./autocomplete";
import { highlightPromptInput } from "./prompthighlight";
import { theme } from "./theme";

afterEach(clearPreferredProvider);

function fixture() {
  const state = createInitialState();
  state.provider = "deepseek";
  state.model = "deepseek-v4-pro";
  state.effort = "high";
  state.fastMode = false;
  state.providerRegistry = [
    {
      id: "deepseek", label: "DeepSeek", defaultModel: "deepseek-v4-pro",
      allowsCustomModels: false, supportsFastMode: false,
      models: [{
        id: "deepseek-v4-pro", label: "Pro", maxContext: 1_000_000,
        supportedEfforts: [{ effort: "high", description: "High" }], defaultEffort: "high",
      }],
    },
    {
      id: "openai", label: "OpenAI", defaultModel: "gpt-6.1-sol",
      allowsCustomModels: true, supportsFastMode: true,
      models: [{
        id: "gpt-6.1-sol", label: "Sol", maxContext: 272_000,
        supportedEfforts: [{ effort: "low", description: "Low" }, { effort: "max", description: "Max" }],
        defaultEffort: "low", supportsUltrafastMode: false,
      }],
    },
  ];
  return state;
}

test("model modifiers work before, within, and after prompt text", () => {
  for (const input of [
    "/model openai gpt-6.1-sol hello there",
    "hello /model openai gpt-6.1-sol there",
    "hello there /model openai gpt-6.1-sol",
  ]) {
    const state = fixture();
    state.inputBuffer = input;
    const result = applyInlineCommands(input, state);
    expect(result.text).toBe("hello there");
    expect(result.modelSelection).toEqual({ provider: "openai", model: "gpt-6.1-sol", effort: "low", fastMode: false });
    expect(state.model).toBe("gpt-6.1-sol");
    expect(state.inputBuffer).toBe(input);
  }
});

test("preview is side-effect free and later modifiers use the newly selected model", () => {
  const state = fixture();
  const text = "/model openai gpt-6.1-sol /effort max /fast on explain this";
  expect(tryCommand(text, state)).toBeNull();
  const preview = previewInlineCommands(text, state);
  expect(preview.text).toBe("explain this");
  expect(preview.modelSelection).toEqual({ provider: "openai", model: "gpt-6.1-sol", effort: "max", fastMode: true });
  expect(state.provider).toBe("deepseek");
  expect(state.effort).toBe("high");
  expect(state.messages).toEqual([]);
  expect(applyInlineCommands(text, state)).toEqual(preview);
  expect(state).toMatchObject(preview.modelSelection!);
});

test("the last model selection normalizes earlier speed and effort changes", () => {
  const state = fixture();
  const result = applyInlineCommands("/model openai gpt-6.1-sol /fast on /model deepseek deepseek-v4-pro answer", state);
  expect(result.text).toBe("answer");
  expect(result.modelSelection).toEqual({ provider: "deepseek", model: "deepseek-v4-pro", effort: "high", fastMode: false });
  expect(state).toMatchObject(result.modelSelection!);
});

test("invalid or unavailable modifiers do not partially switch models", () => {
  for (const text of [
    "hello /model unknown nope",
    "hello /model deepseek typo",
    "hello /model openai",
    "/model openai gpt-6.1-sol /ultrafast on hello",
  ]) {
    const state = fixture();
    expect(applyInlineCommands(text, state).error).toBeTruthy();
    expect(state.provider).toBe("deepseek");
    expect(state.model).toBe("deepseek-v4-pro");
    expect(state.effort).toBe("high");
    expect(state.fastMode).toBe(false);
  }
});

test("streaming model switches are blocked, including inline prompts", () => {
  const state = fixture();
  state.convId = "streaming";
  state.pendingAI = { role: "assistant", blocks: [], metadata: null };
  expect(applyInlineCommands("hello /model openai gpt-6.1-sol", state).error)
    .toBe("Cannot switch provider/model while this conversation is streaming.");
  expect(state.model).toBe("deepseek-v4-pro");
});

test("standalone model views and custom model IDs keep working", () => {
  for (const text of ["/model", "/model openai"]) {
    expect(tryCommand(text, fixture())).toEqual({ type: "handled" });
  }
  expect(tryCommand("/model openai gpt-6.1-sol", fixture())).toEqual({ type: "handled" });
  expect(applyInlineCommands("hello /model openai custom.model", fixture()).modelSelection?.model).toBe("custom.model");
});

test("queued prompts and command compositions retain the final model selection", () => {
  const state = fixture();
  state.convId = "queued";
  const result = applyInlineCommands("/model openai gpt-6.1-sol hello /queue", state);
  expect(result).toMatchObject({ text: "hello", queue: { type: "global" }, modelSelection: { model: "gpt-6.1-sol" } });
  state.messages.push({ role: "user", text: "earlier prompt", metadata: null });
  const command = tryCommand("/replay /model openai gpt-6.1-sol /queue", state);
  expect(command).toMatchObject({ modelSelection: { model: "gpt-6.1-sol" }, queue: { type: "global" } });
});

test("inline model completion and highlighting match standalone syntax", () => {
  const state = fixture();
  expect(getInlineCommandArgs(state, "/model")).toEqual(getCommandArgs(state, "/model"));
  state.inputBuffer = "please /model openai gpt-6.";
  state.cursorPos = state.inputBuffer.length;
  updateAutocomplete(state);
  expect(state.autocomplete?.matches.map(item => item.name)).toEqual(["gpt-6.1-sol"]);
  const input = "please /model openai custom.model answer";
  expect(highlightPromptInput(state, [input], input, 120, 0)).toEqual([
    `please ${theme.command}/model openai custom.model${theme.reset} answer`,
  ]);
});
