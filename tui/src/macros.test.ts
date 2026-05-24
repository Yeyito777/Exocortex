import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { externalToolsDir, externalToolsTrashDir } from "@exocortex/shared/paths";
import { getMacroArgs, expandMacros } from "./macros";

const TEST_TOOL_DIR = `${externalToolsDir()}/tool-macros-test-cli`;

afterEach(() => {
  rmSync(TEST_TOOL_DIR, { recursive: true, force: true });
});

describe("macro expansion", () => {
  test("/xenv expands to the xenv test loop prompt", () => {
    expect(expandMacros("/xenv")).toBe("You're going to test this in a xenv and go into a loop: build → test in xenv → fix anything that's wrong → ... until it's complete");
  });

  test("/exocortex exposes quality task macros", () => {
    expect(getMacroArgs()["/exocortex"]?.map(arg => arg.name)).toEqual(["tui-quality", "daemon-quality"]);
  });

  test("/exocortex quality task macros expand to scoped worktree prompts", () => {
    expect(expandMacros("/exocortex tui-quality")).toContain("Check the code quality of exocortex's tui.");
    expect(expandMacros("/exocortex daemon-quality")).toContain("Check the code quality of exocortex's daemon.");
    expect(expandMacros("/exocortex tui-quality")).toContain("./scripts/dev/create-worktree <name>");
    expect(expandMacros("/exocortex daemon-quality")).toContain("./scripts/dev/clean-worktree <name-or-path>");
    expect(expandMacros("/exocortex tui-quality")).toContain("Once done, test end to end with xenv to make sure nothing broke.");
    expect(expandMacros("/exocortex daemon-quality")).toContain("Once done, test the daemon in the worktree end to end with exo-cli to make sure nothing broke. Check exo-cli -h first to see how to test in worktree.");
  });

  test("/worktree exposes setup, ready, and merge helpers", () => {
    expect(getMacroArgs()["/worktree"]?.map(arg => arg.name)).toEqual(["setup", "ready", "merge"]);
  });

  test("/worktree setup expands to a concise reference-based setup prompt", () => {
    const expanded = expandMacros("/worktree setup ~/Workspace/example-project");

    expect(expanded).toContain("If the project is not already a git repo, initialize git first.");
    expect(expanded).toContain("~/Workspace/exocortex/scripts/dev/create-worktree");
    expect(expanded).toContain("~/Workspace/exocortex/scripts/dev/worktree-common.sh");
    expect(expanded).toContain("~/Workspace/exocortex/.githooks/post-checkout");
    expect(expanded).toContain("~/Workspace/active-development/record/scripts/dev/create-worktree");
    expect(expanded).toContain("make scripts executable");
    expect(expanded).toContain("smoke-test create + clean");
    expect(expanded).toEndWith("Project: ~/Workspace/example-project");
  });

  test("/autoresearch expands to the autoresearch workflow prompt and preserves topic", () => {
    const expanded = expandMacros("/autoresearch improve benchmark quality");

    expect(expanded).toContain("You're going to autoresearch.");
    expect(expanded).toContain("Set yourself a goal in accordance with the topic");
    expect(expanded).toContain("pausable=false and completable=false");
    expect(expanded).toContain("unpausable and uncompletable");
    expect(expanded).not.toContain("not allowed to pause it");
    expect(expanded).toContain("autoresearch/<topic>");
    expect(expanded).toContain("you must create a benchmark first");
    expect(expanded).toContain("Make sure to not use subagents.");
    expect(expanded).toContain("ask him 5 questions before you actually start");
    expect(expanded).toContain("set yourself the goal AFTER the user has answered the five questions");
    expect(expanded).toEndWith("improve benchmark quality");
  });

  test("/autoresearch exposes and expands stop helper", () => {
    expect(getMacroArgs()["/autoresearch"]?.map(arg => arg.name)).toEqual(["stop"]);

    const expanded = expandMacros("/autoresearch stop");

    expect(expanded).toContain("You're going to stop autoresearching.");
    expect(expanded).toContain("wrap up your last experiment");
    expect(expanded).toContain("create an html report of the autoresearch");
    expect(expanded).toContain("Save it to a file in ~/Workspace/playground/");
  });
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
