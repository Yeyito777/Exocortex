import { describe, expect, test } from "bun:test";
import { buildRealtimeDelegationMessage } from "./realtime-delegation";

const ownerSpeaker = {
  kind: "single" as const,
  participants: [{ id: "310543961825738754", displayName: "Yeyito", trust: "owner" as const }],
};

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
    expect(buildRealtimeDelegationMessage("Inspect the repository.")).toBe(
      "[realtime delegation]\n" +
      "Task: Inspect the repository.\n" +
      "\n" +
      "Action: Complete only the backend task and return its result without conversational filler or progress narration. GPT-Live handles the live conversation.",
    );
  });

  test("omits original speech when only whitespace differs", () => {
    expect(buildRealtimeDelegationMessage(
      "Inspect   the repository.\nNow.",
      " Inspect the repository. Now. ",
    )).not.toContain("Original speech:");
  });

  test("includes adapter-authenticated speaker identity and trust", () => {
    expect(buildRealtimeDelegationMessage("Inspect it.", undefined, ownerSpeaker)).toContain(
      "Speaker: Yeyito <310543961825738754> [owner]",
    );
    expect(buildRealtimeDelegationMessage("Inspect it.", undefined, {
      kind: "multiple",
      participants: [
        ownerSpeaker.participants[0],
        { id: "friend", displayName: "Friend", trust: "friend" },
      ],
    })).toContain("Speakers (overlap): Yeyito <310543961825738754> [owner], Friend <friend> [friend]");
    expect(buildRealtimeDelegationMessage("Inspect it.", undefined, {
      kind: "unknown",
      participants: [],
    })).toContain("Speaker: unknown [untrusted]");
  });
});
