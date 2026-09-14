import { describe, expect, test } from "bun:test";
import type { ApiMessage } from "../../messages";
import {
  buildOpenAIInputForTest,
  buildRequestBodyForTest,
  readOpenAIEventsForTest,
} from "./api";

const patchGrammar = {
  type: "grammar" as const,
  syntax: "lark" as const,
  definition: "start: /(?s:.+)/",
};

const rawPatch = "*** Begin Patch\n*** Update File: src/café/λ.ts\n@@\n-export const greeting = 'hello';\n+export const greeting = 'こんにちは 👋';\n*** End Patch\n";
const toolOutput = "applied café/λ.ts\n✓ 1 file changed\n";

const applyPatchTool = {
  name: "apply_patch",
  description: "Apply an exact patch payload.",
  input_schema: { type: "object", properties: { input: { type: "string" } } },
  freeform: patchGrammar,
};

const ordinaryFunction = {
  name: "read_file",
  description: "Read one file.",
  input_schema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

const expectedCustomDefinition = {
  type: "custom",
  name: "apply_patch",
  description: "Apply an exact patch payload.",
  format: patchGrammar,
};

const expectedFunctionDefinition = {
  type: "function",
  name: "read_file",
  description: "Read one file.",
  parameters: ordinaryFunction.input_schema,
  strict: false,
};

describe("OpenAI freeform apply_patch transport", () => {
  test("uses a custom definition in standard Responses while leaving ordinary functions unchanged", () => {
    const body = buildRequestBodyForTest(
      [{ role: "user", content: "Patch src/café/λ.ts" }],
      "gpt-5.6-sol",
      0,
      { tools: [applyPatchTool, ordinaryFunction] },
    );

    expect(body.tools).toEqual([expectedCustomDefinition, expectedFunctionDefinition]);
    expect(body.input).toEqual([{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Patch src/café/λ.ts" }],
    }]);
  });

  test("uses the same custom definition in the Responses Lite functions namespace", () => {
    const body = buildRequestBodyForTest(
      [{ role: "user", content: "Patch src/café/λ.ts" }],
      "gpt-6-astra",
      0,
      { tools: [applyPatchTool, ordinaryFunction] },
    );

    expect(body.tools).toBeUndefined();
    expect(body.input).toEqual([
      {
        type: "additional_tools",
        role: "developer",
        tools: [{
          type: "namespace",
          name: "functions",
          description: "",
          tools: [expectedCustomDefinition, expectedFunctionDefinition],
        }],
      },
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "You are a helpful assistant." }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Patch src/café/λ.ts" }],
      },
    ]);
  });

  test("preserves streamed raw custom input, including unicode and trailing newlines", () => {
    const result = readOpenAIEventsForTest([
      { type: "response.created", response: { id: "resp_streamed_patch" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "custom_tool_call", call_id: "call_patch_streamed", name: "apply_patch" },
      },
      { type: "response.custom_tool_call_input.delta", output_index: 0, delta: rawPatch.slice(0, 57) },
      { type: "response.custom_tool_call_input.delta", output_index: 0, delta: rawPatch.slice(57) },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "custom_tool_call", call_id: "call_patch_streamed", name: "apply_patch" },
      },
      { type: "response.completed", response: { id: "resp_streamed_patch", output: [] } },
    ]);

    const expectedItem = {
      type: "custom_tool_call",
      call_id: "call_patch_streamed",
      name: "apply_patch",
      input: rawPatch,
    };
    expect(result.toolCalls).toEqual([{
      id: "call_patch_streamed",
      name: "apply_patch",
      input: { input: rawPatch },
    }]);
    expect(result.responseOutputItems).toEqual([expectedItem]);

    const replay: ApiMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_patch_streamed", name: "apply_patch", input: { input: rawPatch } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_patch_streamed", content: toolOutput, is_error: false }],
      },
    ];
    expect(buildOpenAIInputForTest(replay)).toEqual([
      expectedItem,
      { type: "custom_tool_call_output", call_id: "call_patch_streamed", output: toolOutput },
    ]);
  });

  test("uses raw custom input supplied by output_item.done or response.completed when no delta was streamed", () => {
    const doneInput = `${rawPatch}# supplied by done\n`;
    const completedInput = `${rawPatch}# supplied by completed\n`;
    const fromDone = readOpenAIEventsForTest([
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "custom_tool_call", call_id: "call_patch_done", name: "apply_patch", input: doneInput },
      },
      { type: "response.completed", response: { id: "resp_done", output: [] } },
    ]);
    const fromCompleted = readOpenAIEventsForTest([
      {
        type: "response.completed",
        response: {
          id: "resp_completed",
          output: [{ type: "custom_tool_call", call_id: "call_patch_completed", name: "apply_patch", input: completedInput }],
        },
      },
    ]);

    expect(fromDone.toolCalls).toEqual([{
      id: "call_patch_done",
      name: "apply_patch",
      input: { input: doneInput },
    }]);
    expect(fromCompleted.toolCalls).toEqual([{
      id: "call_patch_completed",
      name: "apply_patch",
      input: { input: completedInput },
    }]);
    expect(fromCompleted.responseOutputItems).toEqual([{
      type: "custom_tool_call",
      call_id: "call_patch_completed",
      name: "apply_patch",
      input: completedInput,
    }]);
  });

  test("continues to parse and replay ordinary function calls as JSON arguments", () => {
    const result = readOpenAIEventsForTest([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", call_id: "call_read", name: "read_file" },
      },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":"src/café/λ.ts"}' },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "function_call", call_id: "call_read", name: "read_file" },
      },
      { type: "response.completed", response: { id: "resp_read", output: [] } },
    ]);

    expect(result.toolCalls).toEqual([{
      id: "call_read",
      name: "read_file",
      input: { path: "src/café/λ.ts" },
    }]);
    expect(result.responseOutputItems).toEqual([{
      type: "function_call",
      call_id: "call_read",
      name: "read_file",
      arguments: '{"path":"src/café/λ.ts"}',
    }]);
  });
});
