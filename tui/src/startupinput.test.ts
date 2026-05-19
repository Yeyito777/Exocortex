import { describe, expect, test } from "bun:test";
import { stripStartupLaunchEcho } from "./startupinput";

describe("startup input sanitization", () => {
  test("strips the dwm/st exocortex launch command", () => {
    expect(stripStartupLaunchEcho("cd ~/Workspace/exocortex && bun run tui/src/main.ts\n"))
      .toBe("");
  });

  test("keeps real input after the stripped launch command", () => {
    expect(stripStartupLaunchEcho("cd ~/Workspace/exocortex && bun run tui/src/main.ts\nhello"))
      .toBe("hello");
  });

  test("does not strip unrelated first input", () => {
    expect(stripStartupLaunchEcho("hello"))
      .toBe("hello");
  });
});
