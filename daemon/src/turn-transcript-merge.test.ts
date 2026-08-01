import { describe, expect, test } from "bun:test";
import { mergeTurnTranscript } from "./turn-transcript-merge";

interface Message {
  id: string;
}

describe("mergeTurnTranscript", () => {
  test("preserves external messages appended before the first persisted round", () => {
    const owned = new WeakSet<Message>();
    const acknowledgement = { id: "bidi-acknowledgement" };
    const toolCall = { id: "tool-call" };

    expect(mergeTurnTranscript([acknowledgement], owned, [toolCall])).toEqual([
      acknowledgement,
      toolCall,
    ]);
  });

  test("keeps later external messages at their observed completed-round boundary", () => {
    const owned = new WeakSet<Message>();
    const acknowledgement = { id: "bidi-acknowledgement" };
    const firstRound = { id: "old-first-round" };
    const firstInstall = mergeTurnTranscript([acknowledgement], owned, [firstRound]);
    const spokenUpdate = { id: "spoken-update" };

    const replacement = [
      { id: "new-first-round" },
      { id: "new-final-answer" },
    ];
    expect(mergeTurnTranscript([...firstInstall, spokenUpdate], owned, replacement)).toEqual([
      acknowledgement,
      replacement[0],
      spokenUpdate,
      replacement[1],
    ]);
  });

  test("removes obsolete owned messages when the replacement shrinks", () => {
    const owned = new WeakSet<Message>();
    const old = [{ id: "old-1" }, { id: "old-2" }];
    const firstInstall = mergeTurnTranscript([], owned, old);
    const replacement = [{ id: "new-1" }];

    expect(mergeTurnTranscript(firstInstall, owned, replacement)).toEqual(replacement);
  });
});
