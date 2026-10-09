import { describe, expect, test } from "bun:test";
import type { ApiMessage } from "../../messages";
import { buildClaudeUserContent, planClaudePrompt } from "./prompt";

const resumed: ApiMessage = {
  role: "assistant",
  content: [{ type: "text", text: "done" }],
  providerData: { anthropic: { sessionId: "s1", resumeAt: "u1", cwd: "/work" } },
};

describe("Claude Code prompt planning", () => {
  test("resumes the latest Claude Code turn and sends only newer messages", () => {
    const next: ApiMessage = { role: "user", content: "next" };
    const plan = planClaudePrompt([{ role: "user", content: "first" }, resumed, next], "/work");
    expect(plan.resume).toEqual({ sessionId: "s1", resumeAt: "u1", cwd: "/work" });
    expect(plan.pending).toEqual([next]);
    expect(buildClaudeUserContent(plan.pending)).toEqual([{ type: "text", text: "next" }]);
  });

  test("resumes an interrupted turn after its last committed tool round", () => {
    const round: ApiMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }],
        providerData: { anthropic: { sessionId: "s2", resumeAt: "u2", cwd: "/work" } },
      },
    ];
    const partial: ApiMessage = { role: "assistant", content: [{ type: "text", text: "There is a" }] };
    const next: ApiMessage = { role: "user", content: "go on" };
    const plan = planClaudePrompt([{ role: "user", content: "first" }, resumed, { role: "user", content: "list" }, ...round, partial, next], "/work");
    expect(plan.resume).toEqual({ sessionId: "s2", resumeAt: "u2", cwd: "/work" });
    expect(plan.pending).toEqual([partial, next]);
  });

  test("starts fresh when the workspace changed", () => {
    const messages: ApiMessage[] = [resumed, { role: "user", content: "next" }];
    expect(planClaudePrompt(messages, "/elsewhere")).toEqual({ resume: null, pending: messages });
  });

  test("tells the model a replayed turn was interrupted when there is no new user input", () => {
    const content = buildClaudeUserContent([{ role: "assistant", content: [{ type: "text", text: "Both are running." }] }]);
    expect(content).toHaveLength(2);
    expect((content[0] as { text: string }).text).toContain("Assistant:\nBoth are running.");
    expect((content[1] as { text: string }).text).toContain("interrupted before it finished");
    expect(buildClaudeUserContent([])).toEqual([content[1]]);
  });

  test("renders unseen history as a transcript and keeps trailing user images native", () => {
    const content = buildClaudeUserContent([
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] },
      { role: "assistant", content: "there is a.txt" },
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
    ]);
    expect(content).toHaveLength(3);
    const preamble = content[0] as { type: "text"; text: string };
    expect(preamble.text).toContain("User:\nhello");
    expect(preamble.text).toContain("[tool call bash t1]");
    expect(preamble.text).toContain("[tool result t1]\na.txt");
    expect(preamble.text).toContain("Assistant:\nthere is a.txt");
    expect(content[1]).toEqual({ type: "text", text: "look" });
    expect(content[2]).toMatchObject({ type: "image", source: { data: "AAAA" } });
  });
});
