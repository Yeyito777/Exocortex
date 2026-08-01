import { describe, expect, test } from "bun:test";
import { buildRealtimeDelegationMessage } from "./orchestrator";

describe("realtime delegation context", () => {
  test("formats one observable backend request in automated-event style", () => {
    expect(buildRealtimeDelegationMessage(
      "  Okay, read the files and tell me about your day.  ",
      "  Read the relevant Exocortex files and explain what the project does.  ",
    )).toBe(
      "[realtime delegation]\n" +
      "Task: Read the relevant Exocortex files and explain what the project does.\n" +
      "Original speech: Okay, read the files and tell me about your day.\n" +
      "\n" +
      "Action: Complete only the backend task and return its result without conversational filler or progress narration. GPT-Live handles the live conversation.",
    );
  });

  test("defaults the backend task to the original speech", () => {
    expect(buildRealtimeDelegationMessage("Inspect the repository.")).toContain(
      "Task: Inspect the repository.\nOriginal speech: Inspect the repository.",
    );
  });
});
