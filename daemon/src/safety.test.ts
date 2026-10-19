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

describe("path safety (resolved paths)", () => {
  const { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { evaluatePathSafety } = require("./safety") as typeof import("./safety");

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "exo-path-safety-"));
    const sensitive = join(root, "Documents", "Sensitive");
    mkdirSync(sensitive, { recursive: true });
    writeFileSync(join(sensitive, "keys.sh"), "export X=1\n");
    const workspace = join(root, "work", "ws");
    mkdirSync(workspace, { recursive: true });
    symlinkSync(sensitive, join(workspace, "link"));
    const keys = join(sensitive, "keys.sh");
    const reason = "Access to keys.sh is disallowed by user.";
    const config: SafetyConfig = {
      enabled: true,
      read: [{ reason, patterns: [keys] }],
      write: [{ reason, patterns: [keys] }],
      edit: [{ reason, patterns: [keys] }],
      grep: [{ reason, patterns: [keys] }],
    };
    return { root, sensitive, workspace, keys, config, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  test("read is denied however the denied file is spelled", () => {
    const f = fixture();
    try {
      for (const spelled of [
        f.keys,
        f.keys.replace("/Sensitive/", "/Sensitive/./"),
        f.keys.replace("/Documents/", "/Documents//"),
        "../../Documents/Sensitive/keys.sh",
        "link/keys.sh",
      ]) {
        // The text-only check misses all but the first spelling.
        const decision = evaluatePathSafety("read", { file_path: spelled }, f.workspace, f.config);
        expect({ spelled, allowed: decision.allowed }).toEqual({ spelled, allowed: false });
      }
      expect(evaluatePathSafety("read", { file_path: "notes.txt" }, f.workspace, f.config).allowed).toBe(true);
      expect(evaluatePathSafety("attach", { paths: ["ok.png", "link/keys.sh"] }, f.workspace, f.config).allowed).toBe(false);
      expect(evaluatePathSafety("view_image", { path: "../../Documents/Sensitive/keys.sh" }, f.workspace, f.config).allowed).toBe(false);
    } finally { f.cleanup(); }
  });

  test("write, edit and patch honor the write/edit denylists on resolved paths", () => {
    const f = fixture();
    try {
      expect(evaluatePathSafety("write", { file_path: "link/keys.sh" }, f.workspace, f.config).allowed).toBe(false);
      expect(evaluatePathSafety("edit", { path: "../../Documents/Sensitive/./keys.sh" }, f.workspace, f.config).allowed).toBe(false);
      const patch = "*** Begin Patch\n*** Update File: link/keys.sh\n@@\n-export X=1\n+export X=2\n*** End Patch";
      expect(evaluatePathSafety("patch", { input: patch }, f.workspace, f.config).allowed).toBe(false);
      expect(evaluatePathSafety("apply_patch", { input: patch }, f.workspace, f.config).allowed).toBe(false);
      const moveInto = "*** Begin Patch\n*** Update File: a.txt\n*** Move to: link/keys.sh\n*** End Patch";
      expect(evaluatePathSafety("apply_patch", { input: moveInto }, f.workspace, f.config).allowed).toBe(false);
      expect(evaluatePathSafety("write", { file_path: "new/file.txt" }, f.workspace, f.config).allowed).toBe(true);
    } finally { f.cleanup(); }
  });

  test("grep is denied when a denied file lies under its search root", () => {
    const f = fixture();
    try {
      expect(evaluatePathSafety("grep", { pattern: "X", path: f.sensitive }, f.workspace, f.config).allowed).toBe(false);
      expect(evaluatePathSafety("grep", { pattern: "X", path: f.root }, f.workspace, f.config).allowed).toBe(false);
      expect(evaluatePathSafety("grep", { pattern: "X", path: "link" }, f.workspace, f.config).allowed).toBe(false);
      expect(evaluatePathSafety("grep", { pattern: "X", path: "." }, f.workspace, f.config).allowed).toBe(true);
      // Without a path, grep searches the cwd.
      expect(evaluatePathSafety("grep", { pattern: "X" }, f.sensitive, f.config).allowed).toBe(false);
    } finally { f.cleanup(); }
  });
});
