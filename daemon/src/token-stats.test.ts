import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tokenStatsDir } from "@exocortex/shared/paths";
import { getTokenStatsSnapshot, recordTokenUsage, resetTokenStatsForTest } from "./token-stats";

function todayKey(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

describe("token stats", () => {
  beforeEach(() => {
    resetTokenStatsForTest();
  });

  afterEach(() => {
    resetTokenStatsForTest();
  });

  test("records totals by provider, model, and source", () => {
    const first = recordTokenUsage("openai", "gpt-5.4", { inputTokens: 120, outputTokens: 30 }, { source: "conversation", conversationId: "conv-1" });
    const second = recordTokenUsage("openai", "gpt-5.4-mini", { inputTokens: 40, outputTokens: 10 }, { source: "llm_complete" });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    const snapshot = getTokenStatsSnapshot();
    expect(snapshot.today.day).toBe(todayKey());
    expect(snapshot.today.inputTokens).toBe(160);
    expect(snapshot.today.outputTokens).toBe(40);
    expect(snapshot.today.totalTokens).toBe(200);
    expect(snapshot.today.requests).toBe(2);
    expect(snapshot.today.byProvider.openai).toEqual({
      inputTokens: 160,
      outputTokens: 40,
      totalTokens: 200,
      requests: 2,
    });
    expect(snapshot.today.byModel["gpt-5.4"]).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      requests: 1,
    });
    expect(snapshot.today.byModel["gpt-5.4-mini"]).toEqual({
      inputTokens: 40,
      outputTokens: 10,
      totalTokens: 50,
      requests: 1,
    });
    expect(snapshot.today.bySource.conversation).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      requests: 1,
    });
    expect(snapshot.today.bySource.llm_complete).toEqual({
      inputTokens: 40,
      outputTokens: 10,
      totalTokens: 50,
      requests: 1,
    });
    expect(snapshot.lifetime.totalTokens).toBe(200);
    expect(snapshot.days).toHaveLength(1);
  });

  test("canonicalizes anthropic alias models before aggregating", () => {
    recordTokenUsage("anthropic", "opus", { inputTokens: 500, outputTokens: 100 }, { source: "conversation" });

    const snapshot = getTokenStatsSnapshot();
    expect(snapshot.today.byModel.opus).toBeUndefined();
    expect(snapshot.today.byModel["claude-opus-4-6"]).toEqual({
      inputTokens: 500,
      outputTokens: 100,
      totalTokens: 600,
      requests: 1,
    });
  });

  test("merges token stats from other instance files into the lifetime snapshot", () => {
    recordTokenUsage("openai", "gpt-5.4", { inputTokens: 10, outputTokens: 5 }, { source: "conversation" });

    mkdirSync(tokenStatsDir(), { recursive: true });
    writeFileSync(join(tokenStatsDir(), "other-worktree.json"), JSON.stringify({
      version: 1,
      instance: "other-worktree",
      updatedAt: Date.now() - 1000,
      days: {
        [todayKey()]: {
          inputTokens: 20,
          outputTokens: 10,
          totalTokens: 30,
          requests: 1,
          byProvider: {
            anthropic: {
              inputTokens: 20,
              outputTokens: 10,
              totalTokens: 30,
              requests: 1,
            },
          },
          byModel: {
            "claude-sonnet-4-6": {
              inputTokens: 20,
              outputTokens: 10,
              totalTokens: 30,
              requests: 1,
            },
          },
          bySource: {
            conversation: {
              inputTokens: 20,
              outputTokens: 10,
              totalTokens: 30,
              requests: 1,
            },
          },
        },
      },
    }, null, 2));

    const snapshot = getTokenStatsSnapshot();
    expect(snapshot.today.totalTokens).toBe(45);
    expect(snapshot.today.requests).toBe(2);
    expect(snapshot.today.byProvider.openai?.totalTokens).toBe(15);
    expect(snapshot.today.byProvider.anthropic?.totalTokens).toBe(30);
    expect(snapshot.lifetime.totalTokens).toBe(45);
  });
});
