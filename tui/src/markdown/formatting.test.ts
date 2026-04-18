import { describe, expect, test } from "bun:test";
import { formatMarkdown, stripMarkdown } from "./formatting";

describe("markdown inline code formatting", () => {
  test("supports triple-backtick inline code spans without mangling content", () => {
    const input = "foo ```js bar ``` baz";

    expect(stripMarkdown(input)).toBe("foo js bar  baz");
    expect(formatMarkdown(input, "X").plain).toBe("foo js bar  baz");
  });

  test("supports multi-backtick inline code spans", () => {
    const input = "foo ``code with ` inside`` baz";

    expect(stripMarkdown(input)).toBe("foo code with ` inside baz");
    expect(formatMarkdown(input, "X").plain).toBe("foo code with ` inside baz");
  });

  test("supports longer inline code spans around triple backticks", () => {
    const input = "Use `````js````` literally";

    expect(stripMarkdown(input)).toBe("Use js literally");
    expect(formatMarkdown(input, "X").plain).toBe("Use js literally");
  });
});
