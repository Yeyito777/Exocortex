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
 * Add a single entry to the MACROS array below. Everything else —
 * autocomplete, prompt highlighting, sub-arg completion, expansion —
 * is derived automatically.
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

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { CompletionItem } from "./commands";

// ── Exocortex root (derived from this file's location) ─────────

const __filename_ = typeof __filename !== "undefined" ? __filename : fileURLToPath(import.meta.url);
/** Absolute path to the Exocortex repo root (e.g. /home/user/Workspace/Exocortex). */
const EXO_ROOT = resolve(dirname(__filename_), "..", "..");
const TOOLS_DIR = `${EXO_ROOT}/external-tools`;

// ── Single source of truth ───────────────────────────────────────

interface MacroArg {
  name: string;
  desc: string;
  expansion: string;
  args?: MacroArg[];
}

interface MacroDef {
  name: string;
  desc: string;
  expansion: string;
  args?: MacroArg[];
}

/** Build a tool-install expansion string with the dynamic paths. */
function toolInstall(cliName: string, repo: string): MacroArg {
  const shortName = cliName.replace(/-cli$/, "");
  return {
    name: shortName, desc: cliName,
    expansion: `Install the ${cliName} tool for yourself. Clone ${repo} into ${TOOLS_DIR}/${cliName}, then follow the README/setup instructions to build and install it. If the tool requires authentication or API tokens, walk me through the setup step by step — ask me for any credentials or config values you need.`,
  };
}

const MACROS: MacroDef[] = [
  { name: "/consider", desc: "Am I right or wrong?", expansion: "Consider what I'm saying. Am I right or wrong?" },
  {
    name: "/commit", desc: "Commit and push", expansion: "If you haven't already, commit your work and push it.",
    args: [
      { name: "exocortex", desc: `Commit ${EXO_ROOT}`, expansion: `If you haven't already, commit and push the work inside the Exocortex directory (${EXO_ROOT}).` },
    ],
  },
  { name: "/noop", desc: "Thoughts only, no edits", expansion: "Don't do any destructive or modificating actions just yet just tell me your thoughts on this" },
  {
    name: "/plan", desc: "Plan only, no edits", expansion: "Come up with a plan for this and tell me it. Don't write or edit any files.",
    args: [
      { name: "other", desc: "Draft plan for another instance", expansion: "Draft a plan for this as a prompt for another instance. Write it as a kebab-case markdown file inside ~/.config/exocortex/storage/playground/. The file should be self-contained so I can send it to another instance and he gets all the context he needs to work on it." },
    ],
  },
  { name: "/fix", desc: "Go ahead and fix it", expansion: "Go ahead and fix it" },
  { name: "/go", desc: "Go ahead and implement", expansion: "Go ahead and implement that" },
  { name: "/questions", desc: "Any questions?", expansion: "Before we proceed, any questions?" },
  { name: "/thoughts", desc: "Tell me your thoughts", expansion: "Can you tell me your thoughts on this?" },
  { name: "/long", desc: "Work until complete", expansion: "This is a long running task, work tirelessly until you can verify that everything is complete and correct" },
  { name: "/diagnose", desc: "Pinpoint the cause", expansion: "Can you pinpoint the exact cause and tell me your diagnosis?" },
  { name: "/quality", desc: "Code quality assessment", expansion: "Give your changes a code quality assesment. Is there anything that should be split off into other files, de-duplicated, or made more clear?" },
  {
    name: "/worktree", desc: "Work in a git worktree",
    expansion: "Work in a git worktree for this task. Find the repo root first (the directory containing `.git/`; don't assume CWD is it). Create the worktree with `git worktree add .worktrees/<name> -b <name> HEAD` from there. When I say I'm satisfied, merge back to main and clean up: run `git worktree remove .worktrees/<name>`, delete the branch with `git branch -d <name>`, and remove the leftover config dirs `~/.config/exocortex/runtime/<name>/` and `~/.config/exocortex/data/instances/<name>/`.",
    args: [
      { name: "ready", desc: "Merge main in, resolve conflicts, assess", expansion: "Merge main into the worktree branch (use local main, not origin — it's always up to date), resolve any merge conflicts, and give the result a code assessment. Stop and report so I can review before merging." },
      { name: "merge", desc: "Merge worktree back into main", expansion: "The work in the worktree is good. Merge back into main and clean up. Remove the worktree, branch, and any files it might've created in ~/.config/exocortex/data/instances/ and ~/.config/exocortex/runtime/ as a result of being a worktree after confirming a sucessfull merge" },
    ],
  },
  {
    name: "/tool",
    desc: "Manage external tools",
    expansion: "Manage external tools. Use '/tool install <name>' to install a tool.",
    args: [
      {
        name: "install", desc: "Install an external tool",
        expansion: `Install an external tool for yourself. Available tools: discord, exo, gmail, qutebrowser, twitter, whatsapp, xenv. Clone the repo into ${TOOLS_DIR}/ and follow the README/setup instructions to build and install it. If the tool requires authentication or API tokens, walk me through the setup step by step — ask me for any credentials or config values you need.`,
        args: [
          toolInstall("discord-cli", "git@github.com:Yeyito777/discord-cli.git"),
          toolInstall("exo-cli", "https://github.com/Yeyito777/exo-cli.git"),
          toolInstall("gmail-cli", "https://github.com/Yeyito777/gmail-cli.git"),
          toolInstall("qutebrowser-cli", "https://github.com/Yeyito777/qutebrowser-cli.git"),
          toolInstall("twitter-cli", "https://github.com/Yeyito777/twitter-cli.git"),
          toolInstall("whatsapp-cli", "https://github.com/Yeyito777/whatsapp-cli.git"),
          toolInstall("xenv-cli", "https://github.com/Yeyito777/xenv-cli.git"),
        ],
      },
    ],
  },
  { name: "/update", desc: "Update Exocortex", expansion: `Update Exocortex. Pull the latest changes from git, install dependencies, and restart the daemon:\n\n  cd ${EXO_ROOT} && git pull && bun install --frozen-lockfile && systemctl --user restart exocortex-daemon.service\n\nWarn me before restarting the daemon — it will kill your current session.` },
];

// ── Recursive flattening helpers ────────────────────────────────

/** Flatten a macro tree into [key, expansion] pairs for MACRO_MAP. */
function flattenExpansions(prefix: string, node: { expansion: string; args?: MacroArg[] }): [string, string][] {
  const entries: [string, string][] = [[prefix, node.expansion]];
  for (const arg of node.args ?? []) {
    entries.push(...flattenExpansions(`${prefix} ${arg.name}`, arg));
  }
  return entries;
}

/** Flatten a macro tree into [key, CompletionItem[]] pairs for MACRO_ARGS. */
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
export const MACRO_LIST: CompletionItem[] = MACROS.map(m => ({ name: m.name, desc: m.desc }));

/** Expansion text for each macro, keyed by "/name" or "/name arg1 arg2 ...". */
export const MACRO_MAP: Record<string, string> = Object.fromEntries(
  MACROS.flatMap(m => flattenExpansions(m.name, m)),
);

/** Sub-argument lists, keyed by "/name" or "/name arg1 ...". Used by autocomplete and prompt highlighting. */
export const MACRO_ARGS: Record<string, CompletionItem[]> = Object.fromEntries(
  MACROS.flatMap(m => flattenArgLists(m.name, m)),
);

// ── Expansion ─────────────────────────────────────────────────────

/**
 * Expand macro commands in user message text.
 *
 * Captures a slash command followed by any number of trailing words,
 * then tries longest-prefix match in MACRO_MAP. Unrecognised trailing
 * words are preserved after the expansion.
 *
 * Only matches at word boundaries (start of line or after whitespace).
 */
export function expandMacros(text: string): string {
  return text.replace(/(?<=^|\s)(\/[\w-]+(?:[ \t]+[\w-]+)*)/gm, (full) => {
    const words = full.split(/[ \t]+/);
    // Try longest prefix first
    for (let len = words.length; len >= 1; len--) {
      const key = words.slice(0, len).join(" ");
      if (MACRO_MAP[key]) {
        const remainder = words.slice(len).join(" ");
        return remainder ? MACRO_MAP[key] + " " + remainder : MACRO_MAP[key];
      }
    }
    return full;
  });
}
