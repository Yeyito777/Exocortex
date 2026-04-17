import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { externalToolsDir, externalToolsTrashDir } from "@exocortex/shared/paths";
import { getMacroArgs, expandMacros } from "./macros";

const TEST_TOOL_DIR = `${externalToolsDir()}/tool-macros-test-cli`;

afterEach(() => {
  rmSync(TEST_TOOL_DIR, { recursive: true, force: true });
});

describe("tool macros", () => {
  test("/tool exposes both install and uninstall actions", () => {
    expect(getMacroArgs()["/tool"]?.map(arg => arg.name)).toEqual(["install", "uninstall"]);
  });

  test("/tool, /tool install, and /tool uninstall expand to explanatory prompts", () => {
    expect(expandMacros("/tool")).toBe("Explain to me how the external tools system works in Exocortex.");
    expect(expandMacros("/tool install")).toBe("Explain to me how the installation process for a tool looks in Exocortex.");
    expect(expandMacros("/tool uninstall")).toBe("Explain to me how the uninstallation process for a tool looks in Exocortex.");
  });

  test("/tool install exposes the static install tool list", () => {
    expect(getMacroArgs()["/tool install"]?.map(arg => arg.name)).toEqual([
      "discord",
      "exo",
      "gmail",
      "qutebrowser",
      "twitter",
      "whatsapp",
      "xenv",
    ]);
  });

  test("/tool uninstall args are discovered from installed tool directories", () => {
    mkdirSync(TEST_TOOL_DIR, { recursive: true });

    expect(getMacroArgs()["/tool uninstall"]?.map(arg => arg.name)).toContain("tool-macros-test");
  });

  test("dynamic /tool uninstall expands to a soft-delete flow", () => {
    mkdirSync(TEST_TOOL_DIR, { recursive: true });

    const expanded = expandMacros("Please /tool uninstall tool-macros-test after checking the README");

    expect(expanded).toContain(`${externalToolsDir()}/tool-macros-test-cli`);
    expect(expanded).toContain(externalToolsTrashDir());
    expect(expanded).toContain("timestamp suffix");
    expect(expanded).toContain("Do not delete it outright.");
    expect(expanded).toEndWith("after checking the README");
  });
});
