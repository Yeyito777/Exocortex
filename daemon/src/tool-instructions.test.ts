import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "fs";
import { repoRoot } from "@exocortex/shared/paths";
import { buildConversationRequestSurface } from "./conversation-request-surface";
import { setLoadedExternalToolsForTest } from "./external-tools";
import type { Conversation } from "./messages";
import { describeToolInstructions } from "./tool-instructions";
import { getRegisteredTools } from "./tools/registry";
import { hostToolDefs, hostToolInstructions } from "./providers/anthropic/host-tools";
import { toolTextDir, toolTextPath } from "./tools/tool-text";

const DEMO_TOOLS = [
  {
    manifest: { name: "demo", bin: "demo", systemHint: "Run `demo -h`.\nSource at <exocortex-source-dir>/external-tools/demo.", display: { label: "Demo", color: "#ffffff" } },
    binDir: "/tmp/demo/bin",
    toolDir: "/tmp/demo",
  },
  {
    manifest: { name: "quiet", bin: "quiet", systemHint: "", display: { label: "Quiet", color: "#ffffff" } },
    binDir: "/tmp/quiet/bin",
    toolDir: "/tmp/quiet",
  },
];

function surfaceFor(provider: string, model: string) {
  const conversation = { id: `tools-${provider}`, provider, model } as unknown as Conversation;
  return buildConversationRequestSurface(conversation, { conversationId: conversation.id, workingDirectory: "/tmp/tools" });
}

describe("tool instructions", () => {
  test("non-Claude providers: descriptions are the tool schemas and hints the # Internal tools section", () => {
    const restore = setLoadedExternalToolsForTest(DEMO_TOOLS);
    try {
      const surface = surfaceFor("openai", "gpt-6.1-sol");
      const view = describeToolInstructions("openai", "gpt-6.1-sol", "tools-openai");

      expect(view.internal.map(entry => entry.name)).toEqual(surface.tools.map(tool => tool.name));
      expect(view.internal.map(entry => entry.description)).toEqual(surface.tools.map(tool => tool.description));

      const internalSection = "# Internal tools\n" + view.internal.filter(entry => entry.hint).map(entry => `## ${entry.name}\n${entry.hint}`).join("\n");
      expect(surface.system).toContain(`${internalSection}\n\n`);
      expect(view.internal.some(entry => entry.hint)).toBe(true);

      const externalSection = "# External tools\n" + view.external.filter(entry => entry.hint).map(entry => `## ${entry.name}\n${entry.hint}`).join("\n");
      expect(surface.system).toContain(externalSection);
      // Placeholders resolve as they do in the prompt; tools without a hint inject nothing but can be given one.
      const demoHint = `Run \`demo -h\`.\nSource at ${repoRoot()}/external-tools/demo.`;
      expect(view.external).toEqual([
        { name: "demo", source: "/tmp/demo/manifest.json", hint: demoHint, blocks: [{ id: "external:demo", label: "System prompt · manifest systemHint", text: demoHint, source: "/tmp/demo/manifest.json", editable: true }] },
        { name: "quiet", source: "/tmp/quiet/manifest.json", blocks: [{ id: "external:quiet", label: "System prompt · manifest systemHint", text: "", source: "/tmp/quiet/manifest.json", editable: true }] },
      ]);
      // Each tool's blocks are its description and hint files, as the model gets them.
      for (const entry of view.internal) {
        expect(entry.blocks?.map(block => block.id)).toEqual([`internal:${entry.name}:description`, `internal:${entry.name}:hint`]);
        expect(entry.blocks?.[0].text).toBe(entry.description!);
        expect(entry.blocks?.[1].text).toBe(entry.hint ?? "");
      }
    } finally {
      restore();
    }
  });

  test("Claude Code: only the exocortex MCP server's tools, with its server instructions", () => {
    const restore = setLoadedExternalToolsForTest(DEMO_TOOLS);
    try {
      const surface = surfaceFor("anthropic", "claude-opus-5-5");
      const view = describeToolInstructions("anthropic", "claude-opus-5-5", "tools-anthropic");
      const served = hostToolDefs(surface.tools);

      expect(view.internal.map(entry => entry.name)).toEqual(served.map(def => def.name));
      expect(view.internal.map(entry => entry.description)).toEqual(served.map(def => def.description));
      expect(view.internal.map(entry => entry.name)).not.toContain("bash");
      for (const entry of view.internal) expect(entry.hint).toBe(hostToolInstructions(entry.name));
      const exo = view.internal.find(entry => entry.name === "exo")!;
      expect(exo.hintSource).toEndWith("daemon/src/tools/text/exo.mcp.md");
      // exo's server instructions end with its system hint: two files, shown as two blocks.
      expect(exo.blocks?.map(block => block.id)).toEqual(["internal:exo:description", "internal:exo:mcp", "internal:exo:hint"]);
      expect(exo.blocks!.slice(1).map(block => block.text).join("\n")).toBe(exo.hint!);
      expect(view.external.filter(entry => entry.hint).length).toBe(1);
      // The # Internal tools hints are not part of Claude Code's prompt.
      expect(surface.system).not.toContain("# Internal tools");
      expect(surface.system).toContain("# External tools\n" + view.external.filter(entry => entry.hint).map(entry => `## ${entry.name}\n${entry.hint}`).join("\n"));
      expect(view.route).toContain("Claude Code");
    } finally {
      restore();
    }
  });

  test("a chat-only model is told about no tools", () => {
    const restore = setLoadedExternalToolsForTest(DEMO_TOOLS);
    try {
      const view = describeToolInstructions("openrouter", "nousresearch/hermes-4-405b");
      expect(surfaceFor("openrouter", "nousresearch/hermes-4-405b").system).not.toContain("# External tools");
      expect(view.internal).toEqual([]);
      expect(view.external).toEqual([]);
    } finally {
      restore();
    }
  });

  test("every built-in tool points at its description file", () => {
    for (const provider of ["openai", "anthropic"] as const) {
      for (const entry of describeToolInstructions(provider, null).internal) {
        expect(existsSync(entry.source)).toBe(true);
        expect(entry.source).toBe(toolTextPath(entry.name, "description"));
      }
    }
    expect(getRegisteredTools().length).toBeGreaterThan(0);
  });

  test("every built-in tool's text file exists and is non-empty, with every placeholder known", () => {
    const files = new Set<string>();
    for (const tool of getRegisteredTools()) {
      files.add(toolTextPath(tool.name, "description"));
      if (existsSync(toolTextPath(tool.name, "hint"))) files.add(toolTextPath(tool.name, "hint"));
      expect(tool.description.trim()).not.toBe("");
      expect(tool.description).not.toContain("{{");
      expect(tool.systemHint ?? "").not.toContain("{{");
    }
    for (const name of ["chrono", "exo"]) {
      files.add(toolTextPath(name, "mcp"));
      expect(hostToolInstructions(name)).not.toContain("{{");
    }
    for (const file of files) {
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, "utf-8").trim()).not.toBe("");
    }
    // Nothing in the folder belongs to no tool.
    const names = new Set(getRegisteredTools().map(tool => tool.name));
    for (const file of readdirSync(toolTextDir())) {
      const match = /^(.+)\.(description|hint|mcp)\.md$/.exec(file);
      expect(match && names.has(match[1])).toBeTruthy();
    }
  });
});
