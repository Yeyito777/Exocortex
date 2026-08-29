import { describe, expect, test } from "bun:test";
import { buildRealtimeDelegationMessage } from "./realtime-delegation";

const ownerSpeaker = {
  kind: "single" as const,
  participants: [{ id: "310543961825738754", displayName: "Yeyito", trust: "owner" as const }],
};

describe("realtime delegation context", () => {
  test("formats one structured observable backend request", () => {
    const message = buildRealtimeDelegationMessage(
      "  Okay, read the files and tell me about your day.  ",
      "  Read the relevant Exocortex files and explain what the project does.  ",
      ownerSpeaker,
      [
        { role: "user", text: "Can you hear me snapping?" },
        { role: "assistant", text: "I did not detect it." },
      ],
    );

    expect(message).toStartWith("[realtime delegation]\n<realtime_delegation>");
    expect(message).toContain("<input>Read the relevant Exocortex files and explain what the project does.</input>");
    expect(message).toContain("<original_speech>Okay, read the files and tell me about your day.</original_speech>");
    expect(message).toContain("<speaker>Yeyito &lt;310543961825738754&gt; [owner]</speaker>");
    expect(message).toContain("<transcript_delta>user: Can you hear me snapping?\nassistant: I did not detect it.</transcript_delta>");
    expect(message).toEndWith("</realtime_delegation>");
  });

  test("defaults the backend task to the original speech", () => {
    const message = buildRealtimeDelegationMessage("Inspect the repository.");
    expect(message).toContain("<input>Inspect the repository.</input>");
    expect(message).not.toContain("<original_speech>");
  });

  test("omits original speech when only whitespace differs", () => {
    expect(buildRealtimeDelegationMessage(
      "Inspect   the repository.\nNow.",
      " Inspect the repository. Now. ",
    )).not.toContain("<original_speech>");
  });

  test("escapes delegated text and includes authenticated speaker trust", () => {
    const single = buildRealtimeDelegationMessage("Inspect <it> & report.", undefined, ownerSpeaker);
    expect(single).toContain("<input>Inspect &lt;it&gt; &amp; report.</input>");
    expect(single).toContain("<speaker>Yeyito &lt;310543961825738754&gt; [owner]</speaker>");

    expect(buildRealtimeDelegationMessage("Inspect it.", undefined, {
      kind: "multiple",
      participants: [
        ownerSpeaker.participants[0],
        { id: "friend", displayName: "Friend", trust: "friend" },
      ],
    })).toContain("<speaker>overlap: Yeyito &lt;310543961825738754&gt; [owner], Friend &lt;friend&gt; [friend]</speaker>");
    expect(buildRealtimeDelegationMessage("Inspect it.", undefined, {
      kind: "unknown",
      participants: [],
    })).toContain("<speaker>unknown [untrusted]</speaker>");
  });
});
