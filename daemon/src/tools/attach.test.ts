import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attach, MAX_ATTACH_IMAGES } from "./attach";
import { findStoredImage, imageIdForBytes } from "../attachments";
import { buildExecutor } from "./registry";
import { isClaudeCodeHostTool } from "./claude-code";

let dir: string;


beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "exo-attach-tool-"));
  const proc = Bun.spawnSync(["magick", "-size", "120x60", "xc:orange", join(dir, "plot.png")]);
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  Bun.spawnSync(["magick", "-size", "10x10", "xc:navy", join(dir, "dot.jpg")]);
  writeFileSync(join(dir, "readme.txt"), "not an image");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("attach tool", () => {
  test("validates its input", async () => {
    expect((await attach.execute({}, { cwd: dir })).output).toContain("non-empty array");
    expect((await attach.execute({ paths: [] }, { cwd: dir })).isError).toBe(true);
    expect((await attach.execute({ paths: [""] }, { cwd: dir })).output).toContain("non-empty string");
    const tooMany = await attach.execute({ paths: Array.from({ length: MAX_ATTACH_IMAGES + 1 }, () => "plot.png") }, { cwd: dir });
    expect(tooMany).toMatchObject({ isError: true });
    expect(tooMany.output).toContain(`At most ${MAX_ATTACH_IMAGES}`);
  });

  test("attaches images resolved against the working directory", async () => {
    const result = await attach.execute({ paths: ["plot.png", join(dir, "dot.jpg")] }, { cwd: dir });
    expect(result.isError).toBe(false);
    expect(result.attachments).toHaveLength(2);
    const [plot, dot] = result.attachments!;
    expect(plot).toMatchObject({ mediaType: "image/png", width: 120, height: 60, name: "plot.png" });
    expect(plot.id).toBe(imageIdForBytes(readFileSync(join(dir, "plot.png"))));
    expect(dot).toMatchObject({ mediaType: "image/jpeg", width: 10, height: 10, name: "dot.jpg" });
    expect(findStoredImage(plot.id)).not.toBeNull();
    expect(result.output).toContain("Attached 2 images");
    expect(result.output).toContain("plot.png (120×60 PNG");
  });

  test("attaches nothing when any path is bad, and says why", async () => {
    const result = await attach.execute({ paths: ["plot.png", "missing.png", "readme.txt", "."] }, { cwd: dir });
    expect(result.isError).toBe(true);
    expect(result.attachments).toBeUndefined();
    expect(result.output).toContain("Nothing was attached.");
    expect(result.output).toContain("missing.png: file not found");
    expect(result.output).toContain("readme.txt: not a PNG, JPEG, GIF, or WebP image");
    expect(result.output).toContain(".: not a regular file");
  });

  test("summarizes by file name", () => {
    expect(attach.summarize({ paths: ["/tmp/a/chart.png", "b.jpg"] })).toEqual({ label: "Attach", detail: "chart.png, b.jpg" });
  });

  test("reaches the agent loop through the registry with its attachments", async () => {
    const execute = buildExecutor({ cwd: dir });
    const [result] = await execute([{ id: "call-1", name: "attach", input: { paths: ["plot.png"] } }]);
    expect(result.isError).toBe(false);
    expect(result.attachments?.[0]).toMatchObject({ name: "plot.png", width: 120 });
  });

  test("is offered to Claude Code as a host tool", () => {
    expect(isClaudeCodeHostTool("attach")).toBe(true);
  });
});

test("honors the read tool's safety denylist for each path", async () => {
  const { updateExocortexConfig } = await import("@exocortex/shared/config");
  updateExocortexConfig(config => { config.safety = { read: ["*secret*"] }; });
  try {
    const [result] = await buildExecutor({ cwd: dir })([{ id: "call-2", name: "attach", input: { paths: ["plot.png", "/home/me/secret.png"] } }]);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Blocked by Exocortex safety denylist for tool 'read'");
    expect(result.attachments).toBeUndefined();
  } finally {
    updateExocortexConfig(config => { delete config.safety; });
  }
});
