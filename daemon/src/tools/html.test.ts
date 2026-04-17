import { describe, expect, test } from "bun:test";
import { htmlToMarkdown } from "./html";

describe("htmlToMarkdown", () => {
  test("normalizes relative links and images to absolute URLs", () => {
    const markdown = htmlToMarkdown(`
      <a href="/iree-org/iree/issues/24035">issue</a>
      <a href="../pull/24046">pr</a>
      <a href="#issuecomment-123">comment</a>
      <a href="/foo">it&#x27;s linked</a>
      <img alt="logo" src="./logo.png">
    `, "https://github.com/iree-org/iree/issues/24035");

    expect(markdown).toContain("[issue](https://github.com/iree-org/iree/issues/24035)");
    expect(markdown).toContain("[pr](https://github.com/iree-org/iree/pull/24046)");
    expect(markdown).toContain("[comment](https://github.com/iree-org/iree/issues/24035#issuecomment-123)");
    expect(markdown).toContain("[it's linked](https://github.com/foo)");
    expect(markdown).toContain("![logo](https://github.com/iree-org/iree/issues/logo.png)");
  });
});
