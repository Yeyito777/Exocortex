/**
 * Validator for the deliberately small JSON Schema subset used by native exo
 * commands. No coercion/default insertion: handlers retain semantic validation.
 */
export function validateCommandArgs(schema: Record<string, unknown>, value: unknown, path = "args"): void {
  const type = schema.type;
  const valid = type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
    : type === "array" ? Array.isArray(value)
    : type === "integer" ? typeof value === "number" && Number.isSafeInteger(value)
    : type === "number" ? typeof value === "number" && Number.isFinite(value)
    : type === "string" ? typeof value === "string"
    : type === "boolean" ? typeof value === "boolean"
    : false;
  if (!valid) throw new Error(`${path} must be ${String(type)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    throw new Error(`${path} must be one of: ${schema.enum.join(", ")}`);
  }
  if (typeof value === "number") {
    for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const) {
      const bound = schema[key];
      if (typeof bound !== "number") continue;
      const invalid = key === "minimum" ? value < bound : key === "maximum" ? value > bound
        : key === "exclusiveMinimum" ? value <= bound : value >= bound;
      if (invalid) throw new Error(`${path} violates ${key} ${bound}`);
    }
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateCommandArgs(schema.items as Record<string, unknown>, item, `${path}[${index}]`));
  } else if (type === "object") {
    const object = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!Object.hasOwn(object, key)) throw new Error(`${path}.${key} is required`);
    }
    for (const [key, item] of Object.entries(object)) {
      if (Object.hasOwn(properties, key)) validateCommandArgs(properties[key], item, `${path}.${key}`);
      else if (schema.additionalProperties === false) throw new Error(`Unknown argument: ${path}.${key}`);
    }
  }
}
