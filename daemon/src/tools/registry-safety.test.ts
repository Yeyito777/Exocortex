import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateExocortexConfig } from "@exocortex/shared/config";
import { buildExecutor } from "./registry";

describe("tool dispatch honors the denylist on resolved paths", () => {
  test("read and grep cannot reach a denied file by a relative or roundabout path", async () => {
    const root = mkdtempSync(join(tmpdir(), "exo-registry-safety-"));
    const secretDir = join(root, "Sensitive");
    const workspace = join(root, "ws");
    mkdirSync(secretDir);
    mkdirSync(workspace);
    const keys = join(secretDir, "keys.sh");
    writeFileSync(keys, "export TOKEN=hunter2\n");
    updateExocortexConfig(config => { config.safety = { read: [keys], grep: [keys] }; });
    try {
      const run = buildExecutor({ cwd: workspace });
      const [read] = await run([{ id: "r", name: "read", input: { file_path: "../Sensitive/./keys.sh" } }]);
      expect(read.isError).toBe(true);
      expect(read.output).toContain("Blocked by Exocortex safety denylist");
      expect(read.output).not.toContain("hunter2");
      const [grep] = await run([{ id: "g", name: "grep", input: { pattern: "TOKEN", path: root, output_mode: "content" } }]);
      expect(grep.isError).toBe(true);
      expect(grep.output).not.toContain("hunter2");
    } finally {
      updateExocortexConfig(config => { delete config.safety; });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
