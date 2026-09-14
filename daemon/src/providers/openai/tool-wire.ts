/** Reserved native freeform primitive. Internal transcripts retain JSON inputs
 * so other providers can replay the same conversation without a custom API. */
export function openAIToolCallItem(call: { id: string; name: string; input: Record<string, unknown> }) {
  return call.name === "apply_patch"
    ? { type: "custom_tool_call" as const, call_id: call.id, name: call.name, input: String(call.input.input ?? "") }
    : { type: "function_call" as const, call_id: call.id, name: call.name, arguments: JSON.stringify(call.input) };
}

export function parseOpenAIToolInput(item: Record<string, unknown>, streamed?: string): Record<string, unknown> {
  if (item.type === "custom_tool_call") return { input: typeof item.input === "string" ? item.input : streamed ?? "" };
  return JSON.parse(typeof item.arguments === "string" ? item.arguments : streamed || "{}");
}
