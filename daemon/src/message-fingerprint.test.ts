import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { StoredMessage } from "./messages";
import {
  isPagedUserFingerprint,
  pagedUserFingerprint,
  pagedUserFingerprintMatches,
} from "./message-fingerprint";

describe("paged user fingerprints", () => {
  test("writes content-stable v2 identities while accepting persisted v1 identities", () => {
    const message: StoredMessage = {
      role: "user",
      content: "edit this turn",
      metadata: { startedAt: 10, endedAt: 20, model: "gpt-5.6-sol", tokens: 3 },
    };
    const v2 = pagedUserFingerprint("conversation-a", 4, message);
    expect(v2).toMatch(/^page-v2:[0-9a-f]{24}$/);
    expect(pagedUserFingerprint("conversation-b", 9, {
      ...message,
      contextTokens: {
        version: 1,
        provider: "openai",
        model: "gpt-5.6-sol",
        signature: "derived",
        totalTokens: 579,
        breakdown: {
          userText: 1,
          userImage: 2,
          assistantText: 3,
          toolUse: 4,
          toolResultText: 5,
          toolResultImage: 6,
          thinking: 7,
          providerReasoning: 8,
          systemHint: 9,
        },
        source: "estimated",
        updatedAt: 30,
      },
    })).toBe(v2);
    expect(pagedUserFingerprintMatches(v2, "conversation-a", 4, message)).toBe(true);
    expect(pagedUserFingerprintMatches(v2, "conversation-a", 4, {
      ...message,
      content: "replacement",
    })).toBe(false);

    const legacyHash = createHash("sha256");
    legacyHash.update("conversation-a\n4\n");
    legacyHash.update(JSON.stringify({
      role: message.role,
      content: message.content,
      providerData: null,
    }));
    const v1 = `page-v1:${legacyHash.digest("hex").slice(0, 24)}`;
    expect(isPagedUserFingerprint(v1)).toBe(true);
    expect(pagedUserFingerprintMatches(v1, "conversation-a", 4, message)).toBe(true);
    expect(pagedUserFingerprintMatches(v1, "conversation-b", 4, message)).toBe(false);
  });
});
