/**
 * Macro command definitions and expansion.
 *
 * Macros are text-replacement shortcuts that live entirely in the TUI.
 * They expand inline in user messages before sending to the daemon.
 * e.g. "/go" becomes "Go ahead and implement that".
 *
 * Macros can appear anywhere in a message — start, middle, after a
 * newline — and are expanded at word boundaries. They are never sent
 * to the daemon as slash commands; the daemon only sees the expanded text.
 *
 * ── Adding a new macro ───────────────────────────────────────────
 *
 * Add a single entry to the array returned by macroDefinitions below. Everything else —
 * autocomplete, prompt highlighting, sub-arg completion, expansion —
 * is derived automatically. Filesystem references use the selected daemon's
 * advertised environment, not the SSH client's local installation.
 *
 *   { name: "/example", desc: "Short description", expansion: "Full text sent to daemon" }
 *
 * To add sub-arguments (e.g. "/example foo"):
 *
 *   {
 *     name: "/example",
 *     desc: "Short description",
 *     expansion: "Default expansion for /example",
 *     args: [
 *       { name: "foo", desc: "Foo variant", expansion: "Expansion for /example foo" },
 *     ],
 *   }
 *
 * Args can nest arbitrarily deep (e.g. "/tool install discord"):
 *
 *   {
 *     name: "/tool",
 *     desc: "Manage tools",
 *     expansion: "...",
 *     args: [
 *       {
 *         name: "install", desc: "Install a tool", expansion: "...",
 *         args: [
 *           { name: "discord", desc: "discord-cli", expansion: "Install discord-cli..." },
 *         ],
 *       },
 *     ],
 *   }
 */

import { posix, win32 } from "path";
import { localMacroEnvironment } from "@exocortex/shared/macro-environment";
import type { MacroEnvironment } from "@exocortex/shared/protocol";
import type { CompletionItem } from "./commands";
import type { RenderState } from "./state";

/** Undefined permits local discovery; null explicitly forbids it on a remote route. */
export function macroEnvironmentForState(
  state: Pick<RenderState, "macroEnvironment" | "sshRemote">,
): MacroEnvironment | null | undefined {
  return state.macroEnvironment ?? (state.sshRemote ? null : undefined);
}

function hostPath(environment: MacroEnvironment, ...parts: string[]): string {
  return (environment.pathStyle === "win32" ? win32 : posix).join(...parts);
}

// ── Single source of truth ───────────────────────────────────────

interface ExternalToolSpec {
  cliName: string;
  description: string;
  repo: string;
}

interface InstalledExternalTool {
  argName: string;
  dirName: string;
}

const EXTERNAL_TOOL_SPECS: ExternalToolSpec[] = [
  { cliName: "discord-cli", description: "Discord messages and calls", repo: "https://github.com/Yeyito777/discord-cli.git" },
  { cliName: "exo-cli", description: "Debug other Exocortex instances", repo: "https://github.com/Yeyito777/exo-cli.git" },
  { cliName: "gmail-cli", description: "Read, search, and send email", repo: "https://github.com/Yeyito777/gmail-cli.git" },
  { cliName: "google-cli", description: "Search the web", repo: "https://github.com/Yeyito777/Google.git" },
  { cliName: "image-cli", description: "Generate AI images", repo: "https://github.com/Yeyito777/image-cli.git" },
  { cliName: "linkedin-cli", description: "LinkedIn profiles and connections", repo: "https://github.com/Yeyito777/linkedin-cli.git" },
  { cliName: "transcribe-cli", description: "Transcribe audio files", repo: "https://github.com/Yeyito777/transcribe-cli.git" },
  { cliName: "twitter-cli", description: "Read and post on X", repo: "https://github.com/Yeyito777/twitter-cli.git" },
  { cliName: "whatsapp-cli", description: "Read and send WhatsApp messages", repo: "https://github.com/Yeyito777/whatsapp-cli.git" },
];

function externalToolShortName(cliName: string): string {
  return cliName.replace(/-cli$/, "");
}

/** Use the selected daemon's catalog, never scan the TUI host for a remote route. */
function installedExternalTools(paths: MacroEnvironment): InstalledExternalTool[] {
  return paths.installedToolDirs.map(dirName => ({
    argName: externalToolShortName(dirName),
    dirName,
  })).sort((a, b) => a.argName.localeCompare(b.argName));
}

/** Build a tool-install expansion string with the dynamic paths. */
function toolInstall(spec: ExternalToolSpec, paths: MacroEnvironment): MacroArg {
  const { cliName, description, repo } = spec;
  return {
    name: externalToolShortName(cliName), desc: description,
    expansion: `Install the ${cliName} tool for yourself. Clone ${repo} into ${hostPath(paths, paths.externalToolsDir, cliName)}, then follow the README/setup instructions to build and install it. If the tool requires authentication or API tokens, walk me through the setup step by step — ask me for any credentials or config values you need.`,
  };
}

/** Build a tool-uninstall expansion string with the dynamic paths. */
function toolUninstall(dirName: string, paths: MacroEnvironment): MacroArg {
  return {
    name: externalToolShortName(dirName), desc: dirName,
    expansion: `Uninstall the ${dirName} tool for yourself. Move ${hostPath(paths, paths.externalToolsDir, dirName)} into ${paths.externalToolsTrashDir} (create the trash directory if needed, and add a timestamp suffix instead of overwriting if a folder with that name is already there). Do not delete it outright. After moving it, check whether the tool's README mentions any extra cleanup steps and walk me through them if needed.`,
  };
}

function dynamicToolUninstallArgs(paths: MacroEnvironment): MacroArg[] {
  return installedExternalTools(paths).map(tool => toolUninstall(tool.dirName, paths));
}

const EXOCORTEX_QUALITY_WORKTREE_PROMPT = "Work in a git worktree for this task. Find the repo root first (the directory containing .git/; don't assume CWD is it). From there, create the worktree with `./scripts/dev/create-worktree <name>`. Work inside that worktree. When I say I'm satisfied, merge back to main and clean up with `./scripts/dev/clean-worktree <name-or-path>`.";

const AUTORESEARCH_PROMPT = "You're going to autoresearch. After clarifying the topic, propose a concrete objective the user can start with /goal. Goals can be stopped and explicitly resumed; use Chrono for recurring monitoring rather than an unfinishable goal. Make a gitignored directory in the project called \"autoresearch/<topic>\" for the raw benchmark, experiment outputs, and success/failure ledger. Never force-add or commit this directory. To know which experiments to keep or trash, you must create the benchmark first and make every experiment deterministic against it. On success, commit only the accepted production source, tests, and durable documentation outside the autoresearch directory. On failure, revert, stash, or delete the failed production change after recording the result in the local ledger. This lets repeated experiments improve the benchmark without accumulating generated research artifacts in the repository. Make sure to not use subagents. With all that said, this is the user request to autoresearch; choose how to interpret it as a benchmark and how to begin the research direction. Ask the user 5 questions before starting, and propose the goal AFTER the user has answered the five questions:";

function autoresearchStopPrompt(playgroundDir: string): string {
  return `You're going to stop autoresearching. Make sure to wrap up your last experiment and tidy everything up. Keep only accepted production source, tests, and durable documentation tracked. Finally create an HTML report of the autoresearch. Format your would-be response in HTML, use dark mode for styling, and use tables, graphs, interactive buttons, or whatever method best conveys the results. Save it to a file in \`${playgroundDir}\` (create the directory if needed), remove the local autoresearch directory after the report is safely written unless the user asks to retain it, and give me the report's absolute path.`;
}

function exocortexQualityPrompt(component: "tui" | "daemon"): string {
  const testingPrompt = component === "tui"
    ? "Once done, test end to end with xenv to make sure nothing broke."
    : "Once done, test the daemon in the worktree end to end with exo-cli to make sure nothing broke. Check exo-cli -h first to see how to test in worktree.";

  return `Check the code quality of exocortex's ${component}. Fix the code quality issues you think are worth fixing, let's prioritize the modularity and longevity of this codebase. ${EXOCORTEX_QUALITY_WORKTREE_PROMPT} ${testingPrompt}`;
}

function macroDefinitions(environment: MacroEnvironment | null = localMacroEnvironment()): MacroDef[] {
  const paths: MacroEnvironment = environment ?? {
    repoRoot: "<daemon-repo>",
    storageDir: "<daemon-storage>",
    externalToolsDir: "<daemon-external-tools>",
    externalToolsTrashDir: "<daemon-tools-trash>",
    pathStyle: "posix",
    installedToolDirs: [],
  };
  const EXO_ROOT = paths.repoRoot;
  const PLAYGROUND_DIR = hostPath(paths, paths.storageDir, "playground");
  const WORKTREE_REFERENCE_FILES = [
    "scripts/dev/create-worktree",
    "scripts/dev/clean-worktree",
    "scripts/dev/worktree-common.sh",
    ".gitignore",
    ".githooks/post-checkout",
    "scripts/dev/exotest",
  ].map(file => `\`${hostPath(paths, EXO_ROOT, file)}\``).join(", ");

  return [
  { name: "/consider", desc: "Am I right or wrong?", expansion: "Consider what I'm saying. Am I right or wrong?" },
  {
    name: "/commit", desc: "Commit and push", expansion: "If you haven't already, commit your work and push it.",
    args: [
      { name: "exocortex", desc: `Commit ${EXO_ROOT}`, expansion: `If you haven't already, commit and push the work inside the Exocortex directory (${EXO_ROOT}).` },
    ],
  },
  { name: "/noop", desc: "Thoughts only, no edits", expansion: "Don't do any destructive or modificating actions just yet just tell me your thoughts on this" },
  {
    name: "/todo", desc: "Track and finish a TODO list", expansion: "Make a <name>-todo.md for this with items - [ ] and finish it sequentially.",
    args: [
      { name: "wait", desc: "Pause for TODO review", expansion: "Make a <name>-todo.md for this with items - [ ] and tell me the abs path of it so I can review before you go and finish it sequentially." },
    ],
  },
  {
    name: "/plan", desc: "Plan only, no edits", expansion: "Come up with a plan for this and tell me it. Don't write or edit any files.",
    args: [
      { name: "other", desc: "Draft plan for another instance", expansion: `Draft a plan for this as a prompt for another instance. Write it as a kebab-case markdown file inside \`${PLAYGROUND_DIR}\` (create the directory if needed). The file should be self-contained so I can send it to another instance and he gets all the context he needs to work on it.` },
    ],
  },
  { name: "/fix", desc: "Go ahead and fix it", expansion: "Go ahead and fix it" },
  { name: "/go", desc: "Go ahead and implement", expansion: "Go ahead and implement that" },
  { name: "/questions", desc: "Any questions?", expansion: "Before we proceed, any questions?" },
  { name: "/thoughts", desc: "Tell me your thoughts", expansion: "Can you tell me your thoughts on this?" },
  { name: "/long", desc: "Work until complete", expansion: "This is a long running task, work tirelessly until you can verify that everything is complete and correct" },
  { name: "/subagents", desc: "Delegate when useful", expansion: "Use subagents when parallel work would materially improve speed or quality." },
  { name: "/html", desc: "Respond with saved HTML", expansion: `Format your would-be response in HTML use dark-mode for styling, user tables, graphs, interactive buttons, or whatever method you consider to be best for displaying the information you want to convey to the user. Save it to a file in \`${PLAYGROUND_DIR}\` (create the directory if needed) and give me the absolute file path.` },
  {
    name: "/autoresearch",
    desc: "Start autoresearch",
    expansion: AUTORESEARCH_PROMPT,
    args: [
      { name: "stop", desc: "Stop autoresearching", expansion: autoresearchStopPrompt(PLAYGROUND_DIR) },
    ],
  },
  {
    name: "/publish", desc: "Publish this", expansion: "Start git tracking this, first checking for secrets/private artifacts/history that should not be published. Make a gitignore, MIT license it if appropriate, make upstream repo with gh tool, make it public, give brief description, and commit and push",
    args: [
      { name: "closed", desc: "Publish privately", expansion: "Start git tracking this, first checking for secrets/private artifacts/history that should not be committed. Make a gitignore, make upstream repo with gh tool, make it private, give brief description, and commit and push" },
    ],
  },
  { name: "/diagnose", desc: "Pinpoint the cause", expansion: "Can you pinpoint the exact cause and tell me your diagnosis?" },
  {
    name: "/improve",
    desc: "Improve Exocortex from friction",
    expansion: "Run an Exocortex self-improvement pass: analyze this conversation for mistakes/friction, especially around internal tools, external tools, and the tooling system; inspect the relevant Exocortex/tool code; check recent conversations for recurring patterns; then pick one high-confidence fix and implement it in an Exocortex git worktree using ./scripts/dev/create-worktree <name>. Test it appropriately and report the worktree, changes, tests, and follow-up ideas.",
    args: [
      {
        name: "plan",
        desc: "Analyze only",
        expansion: "Run an Exocortex self-improvement pass: analyze this conversation for mistakes/friction, especially around internal tools, external tools, and the tooling system; inspect the relevant Exocortex/tool code; and check recent conversations for recurring patterns. Then report the best improvement candidates, but don't edit files yet.",
      },
    ],
  },
  { name: "/quality", desc: "Code quality assessment", expansion: "Give the changes a code quality assesment. Is there anything that should be split off into other files, de-duplicated, or made more clear? If so, do it." },
  {
    name: "/exocortex",
    desc: "Exocortex repo tasks",
    expansion: "What would you like to do in the Exocortex repo?",
    args: [
      { name: "tui-quality", desc: "Improve TUI code quality in a worktree", expansion: exocortexQualityPrompt("tui") },
      { name: "daemon-quality", desc: "Improve daemon code quality in a worktree", expansion: exocortexQualityPrompt("daemon") },
    ],
  },
  {
    name: "/worktree", desc: "Work in a git worktree",
    expansion: `Work in a git worktree for this task. Find the repo root first (the directory containing .git/; don't assume CWD is it). From there, create the worktree with \`./scripts/dev/create-worktree <name>\`. Work inside that worktree. When I say I'm satisfied, merge back to main and clean up with \`./scripts/dev/clean-worktree <name-or-path>\`.`,
    args: [
      { name: "setup", desc: "Set up worktree flow for a project", expansion: `Set up git worktree management flow for the project. If the project is not already a git repo, initialize git first. Use the existing Exocortex flow as the reference implementation: ${WORKTREE_REFERENCE_FILES}. Verify these files exist before reading them; if this installation lacks the source scripts, locate an Exocortex source checkout or ask for its location rather than guessing a path. If a local Record checkout is available, also check its scripts/dev/create-worktree, clean-worktree, worktree-common.sh, and recordtest for a smaller app-specific version; skip this optional reference if unavailable. Adapt the flow to this project's deps/config/runtime/test needs and host OS (do not blindly copy platform-specific shell or process checks), make scripts executable, update .gitignore, then smoke-test create + clean with a temporary worktree and leave no temp branch/worktree behind. Project:` },
      { name: "merge", desc: "Merge worktree back into main", expansion: "First merge local main into the worktree branch (use local main, not origin — it's always up to date) and resolve any merge conflicts. The work in the worktree is good. Merge it back into main. After confirming the merge succeeded, run `./scripts/dev/clean-worktree <name-or-path>` from the repo root to remove the worktree, delete its branch, and clean up any worktree config leftovers." },
      { name: "clean", desc: "Reject/discard worktree", expansion: "The work in this worktree is rejected. Do not merge it, do not preserve the changes, and do not try to salvage the branch. Find the repo root first, identify the target worktree from the current directory or from the name/path I provide, verify it is a linked worktree and not main, then remove it and delete its branch. Prefer the project cleanup script, e.g. `./scripts/dev/clean-worktree <name-or-path>`. If cleanup refuses because the worktree is dirty or the branch is unmerged, explicitly discard the worktree changes and force-remove the worktree/branch. Clean up any worktree runtime/config leftovers if the project has them. Report what was removed." },
    ],
  },
  {
    name: "/tool",
    desc: "Manage external tools",
    expansion: "Explain to me how the external tools system works in Exocortex.",
    args: [
      {
        name: "install",
        desc: "Install an external tool",
        expansion: "Explain to me how the installation process for a tool looks in Exocortex.",
        args: EXTERNAL_TOOL_SPECS.map(spec => toolInstall(spec, paths)),
      },
      {
        name: "uninstall",
        desc: "Uninstall an external tool",
        expansion: "Explain to me how the uninstallation process for a tool looks in Exocortex.",
        args: dynamicToolUninstallArgs(paths),
      },
    ],
  },
  { name: "/update", desc: "Update Exocortex", expansion: "Update Exocortex. Pull the latest changes from github, install anything that needs to be installed and then tell me to run \"exocortexd restart\" in my terminal when ready" },
  ];
}

interface MacroArg {
  name: string;
  desc: string;
  expansion: string;
  args?: MacroArg[];
}

type MacroDef = MacroArg;

// ── Recursive flattening helpers ────────────────────────────────

/** Flatten a macro tree into [key, expansion] pairs for the macro map. */
function flattenExpansions(prefix: string, node: { expansion: string; args?: MacroArg[] }): [string, string][] {
  const entries: [string, string][] = [[prefix, node.expansion]];
  for (const arg of node.args ?? []) {
    entries.push(...flattenExpansions(`${prefix} ${arg.name}`, arg));
  }
  return entries;
}

/** Flatten a macro tree into [key, CompletionItem[]] pairs for the arg registry. */
function flattenArgLists(prefix: string, node: { args?: MacroArg[] }): [string, CompletionItem[]][] {
  if (!node.args || node.args.length === 0) return [];
  const entries: [string, CompletionItem[]][] = [
    [prefix, node.args.map(a => ({ name: a.name, desc: a.desc }))],
  ];
  for (const arg of node.args) {
    entries.push(...flattenArgLists(`${prefix} ${arg.name}`, arg));
  }
  return entries;
}

// ── Derived exports ──────────────────────────────────────────────

/** Autocomplete entries for macros (base names only — args appear after selecting the base command). */
export const MACRO_LIST: CompletionItem[] = macroDefinitions(null).map(m => ({ name: m.name, desc: m.desc }));

/** Expansion text for each macro, keyed by "/name" or "/name arg1 arg2 ...". */
export function getMacroMap(environment?: MacroEnvironment | null): Record<string, string> {
  return Object.fromEntries(
    macroDefinitions(environment).flatMap(m => flattenExpansions(m.name, m)).map(([key, expansion]) => [
      key,
      environment === null && expansion.includes("<daemon-")
        ? "Resolve the <daemon-...> path placeholders on the connected daemon host before acting; they are not literal paths. Locate its Exocortex checkout, configured storage, external tools and tool trash directories there, asking if necessary. Never substitute paths from the local TUI host. " + expansion
        : expansion,
    ]),
  );
}

/** Sub-argument lists, keyed by "/name" or "/name arg1 ...". Used by autocomplete and prompt highlighting. */
export function getMacroArgs(baseName?: string, environment?: MacroEnvironment | null): Record<string, CompletionItem[]> {
  return Object.fromEntries(
    macroDefinitions(environment).flatMap(m => flattenArgLists(m.name, m))
      .filter(([key]) => !baseName || key === baseName || key.startsWith(`${baseName} `)),
  );
}

// ── Expansion ─────────────────────────────────────────────────────

/**
 * Expand macro commands in user message text.
 *
 * Captures a slash command followed by any number of trailing words,
 * then tries longest-prefix match in the macro map. Unrecognised trailing
 * words are preserved after the expansion.
 *
 * Only matches at word boundaries (start of line or after whitespace).
 */
export function expandMacros(text: string, environment?: MacroEnvironment | null): string {
  const macroMap = getMacroMap(environment);

  return text.replace(/(?<=^|\s)(\/[\w-]+(?:[ \t]+[\w-]+)*)/gm, (full) => {
    const words = full.split(/[ \t]+/);
    // Older daemons have no catalog, and a freshly installed tool can precede
    // its refresh event. Preserve an explicit uninstall request without guessing
    // a directory name or silently turning it into the explanatory base macro.
    if (words[0] === "/tool" && words[1] === "uninstall" && words[2]
      && !macroMap[words.slice(0, 3).join(" ")]) {
      const expansion = `Uninstall the ${words[2]} external tool on the connected daemon host. Locate its exact installed directory under that daemon's external-tools directory; verify the tool identity rather than guessing its path. Move it into that daemon's external-tools trash directory (create it if needed and use a timestamp suffix to avoid overwriting). Do not delete it outright. Check its README for extra cleanup steps and walk me through them if needed.`;
      const remainder = words.slice(3).join(" ");
      return remainder ? `${expansion} ${remainder}` : expansion;
    }
    // Try longest prefix first
    for (let len = words.length; len >= 1; len--) {
      const key = words.slice(0, len).join(" ");
      if (macroMap[key]) {
        const remainder = words.slice(len).join(" ");
        return remainder ? macroMap[key] + " " + remainder : macroMap[key];
      }
    }
    return full;
  });
}
