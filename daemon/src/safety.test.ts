import { describe, expect, test } from "bun:test";
import { evaluateToolCallSafety, formatSafetyBlock, getToolDenylist } from "./safety";
import type { SafetyConfig } from "@exocortex/shared/config";

const exocortexReason = "Tampering with the Exocortex upstream repo is disallowed by user.";

const safety: SafetyConfig = {
  enabled: true,
  bash: [
    {
      reason: exocortexReason,
      patterns: [
        "*gh repo delete*exocortex*",
        "*gh repo edit*exocortex*--visibility*private*",
        "*gh repo edit*--visibility*private*exocortex*",
        "*gh api*repos/yeyito777/exocortex*private*true*",
      ],
    },
  ],
  read: [
    {
      reason: "Secret files are not readable by agents.",
      patterns: ["*/secret-stuff/*"],
    },
  ],
  write: ["*/do-not-write/*"],
};

describe("safety denylist", () => {
  test("reads direct per-tool denylist entries", () => {
    expect(getToolDenylist(safety, "bash")).toContainEqual({
      pattern: "*gh repo delete*exocortex*",
      reason: exocortexReason,
    });
  });

  test("blocks common GitHub CLI repo deletion", () => {
    const decision = evaluateToolCallSafety("bash", {
      command: "gh repo delete Yeyito777/Exocortex --yes",
    }, safety);
    expect(decision.allowed).toBe(false);
    expect(decision.pattern).toBe("*gh repo delete*exocortex*");
    expect(decision.reason).toBe(exocortexReason);
  });

  test("blocks visibility changes regardless of repo/flag order", () => {
    expect(evaluateToolCallSafety("bash", {
      command: "gh repo edit Yeyito777/Exocortex --visibility private",
    }, safety).allowed).toBe(false);

    expect(evaluateToolCallSafety("bash", {
      command: "gh repo edit --visibility=private Yeyito777/Exocortex",
    }, safety).allowed).toBe(false);
  });

  test("blocks common gh api private toggle", () => {
    const decision = evaluateToolCallSafety("bash", {
      command: "gh api repos/Yeyito777/Exocortex -X PATCH -f private=true",
    }, safety);
    expect(decision.allowed).toBe(false);
  });

  test("allows ordinary GitHub CLI operations", () => {
    const decision = evaluateToolCallSafety("bash", {
      command: "gh repo view Yeyito777/Exocortex --json visibility",
    }, safety);
    expect(decision.allowed).toBe(true);
  });

  test("applies denylist to non-bash tool inputs", () => {
    const readDecision = evaluateToolCallSafety("read", {
      file_path: "/tmp/secret-stuff/token.txt",
    }, safety);
    expect(readDecision.allowed).toBe(false);
    expect(readDecision.reason).toBe("Secret files are not readable by agents.");

    expect(evaluateToolCallSafety("write", {
      file_path: "/tmp/do-not-write/file.txt",
      content: "hello",
    }, safety).allowed).toBe(false);
  });

  test("formatted block includes grouped reason", () => {
    const decision = evaluateToolCallSafety("bash", {
      command: "gh repo delete Yeyito777/Exocortex --yes",
    }, safety);
    expect(formatSafetyBlock(decision)).toContain(`Reason: ${exocortexReason}`);
  });
});
