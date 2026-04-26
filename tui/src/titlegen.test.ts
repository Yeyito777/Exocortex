import { describe, expect, test } from "bun:test";
import { createInitialState } from "./state";
import { generateTitle } from "./titlegen";

describe("generateTitle", () => {
  test("delegates title generation to the daemon", () => {
    const calls: string[] = [];
    generateTitle(
      "conv-1",
      createInitialState(),
      { generateTitle: (convId: string) => calls.push(convId) } as never,
      () => { throw new Error("scheduleRender should not be needed"); },
    );
    expect(calls).toEqual(["conv-1"]);
  });
});
