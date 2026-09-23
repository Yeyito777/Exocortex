import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join, posix, win32 } from "path";
import type { MacroEnvironment } from "@exocortex/shared/protocol";
import { repoRoot, storageDir, externalToolsDir, externalToolsTrashDir } from "@exocortex/shared/paths";
import { getMacroArgs, getMacroMap, expandMacros, MACRO_LIST } from "./macros";
import { createInitialState } from "./state";
import { updateAutocomplete } from "./autocomplete";
import { highlightPromptInput } from "./prompthighlight";
import { theme } from "./theme";

const TEST_TOOL_DIR = `${externalToolsDir()}/tool-macros-test-cli`;

afterEach(() => {
  rmSync(TEST_TOOL_DIR, { recursive: true, force: true });
});

describe("macro expansion", () => {
  test("/xenv is not registered or expanded", () => {
    expect(MACRO_LIST.map(macro => macro.name)).not.toContain("/xenv");
    expect(expandMacros("/xenv")).toBe("/xenv");
  });

  test("/todo expands to the sequential TODO workflow prompt", () => {
    expect(expandMacros("/todo")).toBe("Make a <name>-todo.md for this with items - [ ] and finish it sequentially.");
  });

  test("/todo wait exposes and expands the review-first TODO workflow", () => {
    expect(getMacroArgs()["/todo"]?.map(arg => arg.name)).toEqual(["wait"]);
    expect(expandMacros("/todo wait")).toBe("Make a <name>-todo.md for this with items - [ ] and tell me the abs path of it so I can review before you go and finish it sequentially.");
  });

  test("/subagents requests useful proactive delegation", () => {
    expect(expandMacros("/subagents")).toBe("Use subagents when parallel work would materially improve speed or quality.");
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

  test("/worktree exposes setup, merge, and clean helpers", () => {
    expect(getMacroArgs()["/worktree"]?.map(arg => arg.name)).toEqual(["setup", "merge", "clean"]);
  });

  test("/worktree merge updates the branch from main before merging back", () => {
    const expanded = expandMacros("/worktree merge");

    expect(expanded).toStartWith("First merge local main into the worktree branch");
    expect(expanded).toContain("resolve any merge conflicts");
    expect(expanded).toContain("Merge it back into main");
  });

  test("/worktree clean expands to a rejection cleanup prompt", () => {
    const expanded = expandMacros("/worktree clean hosted-web-run");

    expect(expanded).toContain("The work in this worktree is rejected.");
    expect(expanded).toContain("Do not merge it");
    expect(expanded).toContain("do not preserve the changes");
    expect(expanded).toContain("verify it is a linked worktree and not main");
    expect(expanded).toContain("./scripts/dev/clean-worktree <name-or-path>");
    expect(expanded).toContain("force-remove the worktree/branch");
    expect(expanded).toEndWith("hosted-web-run");
  });

  test("/worktree setup expands to a concise reference-based setup prompt", () => {
    const expanded = expandMacros('/worktree setup "project with spaces"');

    expect(expanded).toContain("If the project is not already a git repo, initialize git first.");
    for (const file of [
      "scripts/dev/create-worktree",
      "scripts/dev/clean-worktree",
      "scripts/dev/worktree-common.sh",
      ".gitignore",
      ".githooks/post-checkout",
      "scripts/dev/exotest",
    ]) {
      expect(expanded).toContain(`\`${join(repoRoot(), file)}\``);
    }
    expect(expanded).toContain("Verify these files exist");
    expect(expanded).toContain("ask for its location rather than guessing a path");
    expect(expanded).toContain("If a local Record checkout is available");
    expect(expanded).toContain("skip this optional reference if unavailable");
    expect(expanded).toContain("host OS");
    expect(expanded).toContain("make scripts executable");
    expect(expanded).toContain("smoke-test create + clean");
    expect(expanded).toEndWith('Project: "project with spaces"');
  });

  test("saved-output macros use the configured storage directory", () => {
    for (const macro of ["/html", "/plan other", "/autoresearch stop"]) {
      const expanded = expandMacros(macro);
      expect(expanded).toContain(`\`${join(storageDir(), "playground")}\``);
      expect(expanded).toContain("create the directory if needed");
    }
  });

  test("macros do not assume a home-directory checkout or config layout", () => {
    for (const expanded of Object.values(getMacroMap())) {
      expect(expanded).not.toContain("~/Workspace/");
      expect(expanded).not.toContain("~/.config/exocortex/");
      expect(expanded).not.toContain("~/Desktop/");
    }
  });

  test("/autoresearch expands to the autoresearch workflow prompt and preserves topic", () => {
    const expanded = expandMacros("/autoresearch improve benchmark quality");

    expect(expanded).toContain("You're going to autoresearch.");
    expect(expanded).toContain("objective the user can start with /goal");
    expect(expanded).toContain("use Chrono for recurring monitoring");
    expect(expanded).not.toContain("completable=false");
    expect(expanded).not.toContain("not allowed to pause it");
    expect(expanded).toContain("autoresearch/<topic>");
    expect(expanded).toContain("gitignored directory");
    expect(expanded).toContain("Never force-add or commit this directory");
    expect(expanded).toContain("commit only the accepted production source");
    expect(expanded).toContain("you must create the benchmark first");
    expect(expanded).toContain("Make sure to not use subagents.");
    expect(expanded).toContain("Ask the user 5 questions before starting");
    expect(expanded).toContain("propose the goal AFTER the user has answered the five questions");
    expect(expanded).toEndWith("improve benchmark quality");
  });

  test("/autoresearch exposes and expands stop helper", () => {
    expect(getMacroArgs()["/autoresearch"]?.map(arg => arg.name)).toEqual(["stop"]);

    const expanded = expandMacros("/autoresearch stop");

    expect(expanded).toContain("You're going to stop autoresearching.");
    expect(expanded).toContain("wrap up your last experiment");
    expect(expanded).toContain("create an HTML report of the autoresearch");
    expect(expanded).toContain(`Save it to a file in \`${join(storageDir(), "playground")}\``);
    expect(expanded).toContain("remove the local autoresearch directory");
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

  test("/tool install exposes the canonical tool catalog", () => {
    expect(getMacroArgs()["/tool install"]).toEqual([
      { name: "discord", desc: "Discord messages and calls" },
      { name: "exo", desc: "Debug other Exocortex instances" },
      { name: "gmail", desc: "Read, search, and send email" },
      { name: "google", desc: "Search the web" },
      { name: "image", desc: "Generate AI images" },
      { name: "linkedin", desc: "LinkedIn profiles and connections" },
      { name: "transcribe", desc: "Transcribe audio files" },
      { name: "twitter", desc: "Read and post on X" },
      { name: "whatsapp", desc: "Read and send WhatsApp messages" },
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

describe("daemon-host macro paths", () => {
  const remote: MacroEnvironment = {
    repoRoot: "/srv/remote exocortex",
    storageDir: "/var/lib/remote config/storage",
    externalToolsDir: "/srv/remote exocortex/external-tools",
    externalToolsTrashDir: "/var/lib/remote config/data/trash/external-tools",
    pathStyle: "posix",
    installedToolDirs: ["remote-only-cli"],
  };

  for (const environment of [
    remote,
    {
      ...remote,
      repoRoot: "D:\\Remote Exocortex",
      storageDir: "E:\\Remote Config\\storage",
      externalToolsDir: "D:\\Remote Exocortex\\external-tools",
      externalToolsTrashDir: "E:\\Remote Config\\data\\trash\\external-tools",
      pathStyle: "win32" as const,
    },
  ]) {
    test(`all filesystem macros use the daemon's ${environment.pathStyle} paths`, () => {
      const path = environment.pathStyle === "win32" ? win32 : posix;
      expect(expandMacros("/worktree setup", environment))
        .toContain(path.join(environment.repoRoot, "scripts/dev/create-worktree"));
      expect(expandMacros("/commit exocortex", environment)).toContain(environment.repoRoot);
      expect(getMacroArgs("/commit", environment)["/commit"]![0].desc).toContain(environment.repoRoot);
      for (const macro of ["/html", "/plan other", "/autoresearch stop"]) {
        expect(expandMacros(macro, environment)).toContain(path.join(environment.storageDir, "playground"));
      }
      expect(expandMacros("/tool install google", environment))
        .toContain(path.join(environment.externalToolsDir, "google-cli"));
      const uninstall = expandMacros("/tool uninstall remote-only", environment);
      expect(uninstall).toContain(path.join(environment.externalToolsDir, "remote-only-cli"));
      expect(uninstall).toContain(environment.externalToolsTrashDir);
      expect(getMacroArgs("/tool", environment)["/tool uninstall"]).toEqual([
        { name: "remote-only", desc: "remote-only-cli" },
      ]);
      const state = createInitialState();
      state.sshRemote = { alias: "remote", connected: true };
      state.macroEnvironment = environment;
      state.inputBuffer = "/tool uninstall remote-";
      state.cursorPos = state.inputBuffer.length;
      updateAutocomplete(state);
      expect(state.autocomplete?.matches.map(match => match.name)).toEqual(["remote-only"]);
      const input = "/tool uninstall remote-only";
      expect(highlightPromptInput(state, [input], input, 120, 0)[0])
        .toBe(`${theme.command}${input}${theme.reset}`);
      for (const expanded of Object.values(getMacroMap(environment))) {
        expect(expanded).not.toContain(repoRoot());
        expect(expanded).not.toContain(storageDir());
      }
    });
  }

  test("missing remote metadata never falls back to local paths or installed tools", () => {
    mkdirSync(TEST_TOOL_DIR, { recursive: true });
    for (const macro of ["/worktree setup", "/commit exocortex", "/html", "/plan other", "/autoresearch stop", "/tool install google"]) {
      const expanded = expandMacros(macro, null);
      expect(expanded).toContain("Resolve the <daemon-...> path placeholders on the connected daemon host");
      expect(expanded).not.toContain(repoRoot());
      expect(expanded).not.toContain(storageDir());
    }
    expect(getMacroArgs("/tool", null)["/tool uninstall"] ?? []).toEqual([]);
    const uninstall = expandMacros("/tool uninstall discord after checking README", null);
    expect(uninstall).toContain("Uninstall the discord external tool on the connected daemon host");
    expect(uninstall).toContain("verify the tool identity rather than guessing");
    expect(uninstall).toContain("Do not delete it outright.");
    expect(uninstall).toEndWith("after checking README");
    expect(uninstall).not.toContain(repoRoot());
    expect(expandMacros("/go", null)).toBe(expandMacros("/go"));
  });
});
