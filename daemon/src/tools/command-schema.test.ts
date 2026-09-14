import { describe, expect, test } from "bun:test";
import { validateCommandArgs } from "./command-schema";

describe("native command schema validation", () => {
  const schema = {
    type: "object", required: ["operation"], additionalProperties: false,
    properties: {
      operation: { type: "string", enum: ["set"] },
      tools: { type: "array", items: { type: "string" } },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      timeout: { type: "number", exclusiveMinimum: 0 },
      nested: { type: "object", properties: { enabled: { type: "boolean" } }, additionalProperties: false },
    },
  };

  test("accepts valid arguments without rewriting payloads or adding defaults", () => {
    const args = { operation: "set", tools: [" exact\ntext "] };
    validateCommandArgs(schema, args);
    expect(args).toEqual({ operation: "set", tools: [" exact\ntext "] });
  });

  test("rejects missing, unknown, mistyped, out-of-range, and nested-invalid arguments", () => {
    for (const args of [
      {}, null, [], { operation: "delete" }, { operation: "set", typo: true },
      { operation: "set", limit: "2" }, { operation: "set", limit: 1.5 },
      { operation: "set", limit: 0 }, { operation: "set", limit: 101 },
      { operation: "set", timeout: 0 }, { operation: "set", timeout: NaN },
      { operation: "set", tools: [1] }, { operation: "set", nested: { enabled: "false" } },
      { operation: "set", nested: { surprise: true } },
    ]) expect(() => validateCommandArgs(schema, args)).toThrow();
  });
});
