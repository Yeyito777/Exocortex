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
 */

import type { CompletionItem } from "./commands";

// ── Single source of truth ───────────────────────────────────────

interface MacroDef {
  name: string;
  desc: string;
  expansion: string;
  args?: { name: string; desc: string; expansion: string }[];
}

const MACROS: MacroDef[] = [
  { name: "/consider", desc: "Am I right or wrong?", expansion: "Consider what I'm saying. Am I right or wrong?" },
  {
    name: "/commit", desc: "Commit and push", expansion: "If you haven't already, commit your work and push it.",
    args: [
      { name: "exocortex", desc: "Commit ~/Workspace/Exocortex", expansion: "If you haven't already, commit and push the work inside the Exocortex directory (~/Workspace/Exocortex)." },
    ],
  },
  { name: "/noop", desc: "Thoughts only, no edits", expansion: "Don't write or edit any files yet. Just tell me your thoughts on this." },
  {
    name: "/plan", desc: "Plan only, no edits", expansion: "Come up with a plan for this and tell me it. Don't write or edit any files.",
    args: [
      { name: "other", desc: "Draft plan for another instance", expansion: "Draft a plan for this as a prompt for another instance. Write it as a kebab-case markdown file inside ~/.config/exocortex/playground/. The file should be self-contained so I can send it to another instance and he gets all the context he needs to work on it." },
    ],
  },
  { name: "/fix", desc: "Go ahead and fix it", expansion: "Go ahead and fix it" },
  { name: "/go", desc: "Go ahead and implement", expansion: "Go ahead and implement that" },
  { name: "/questions", desc: "Any questions?", expansion: "Before we proceed, any questions?" },
  { name: "/thoughts", desc: "Tell me your thoughts", expansion: "Can you tell me your thoughts on this?" },
  { name: "/long", desc: "Work until complete", expansion: "This is a long running task, work tirelessly until you can verify that everything is complete and correct" },
  { name: "/diagnose", desc: "Pinpoint the cause", expansion: "Can you pinpoint the exact cause and tell me your diagnosis?" },
  { name: "/quality", desc: "Code quality assessment", expansion: "Give your changes a code quality assesment. Is there anything that should be split off into other files, de-duplicated, or made more clear?" },
  { name: "/qutebrowser", desc: "Qutebrowser CLI context", expansion: "You have access to qutebrowser through the qb CLI tool (IN YOUR PATH, source at ~/Workspace/qutebrowser-cli/). Run qb -h for usage reference." },
  { name: "/gmail", desc: "Gmail tool context", expansion: "You have access to my gmail through the gmail CLI tool (IN YOUR PATH, source at ~/Workspace/gmail-cli) Run gmail -h for usage reference." },
  { name: "/twitter", desc: "Twitter tool context", expansion: "You have access to Twitter/X through the twitter CLI tool (IN YOUR PATH, source at /Workspace/twitter/). Run twitter -h for usage reference." },
  {
    name: "/worktree", desc: "Work in a git worktree",
    expansion: "Work in a git worktree for this task. Find the repo root first (the directory containing `.git/`; don't assume CWD is it). Create the worktree with `git worktree add .worktrees/<name> -b <name> HEAD` from there. When I say I'm satisfied, merge back to main and clean up: run `git worktree remove .worktrees/<name>`, delete the branch with `git branch -d <name>`, and remove the leftover config dirs `~/.config/exocortex/runtime/<name>/` and `~/.config/exocortex/instances/<name>/`.",
    args: [
      { name: "ready", desc: "Merge main in, resolve conflicts, assess", expansion: "Merge main into the worktree branch (use local main, not origin — it's always up to date), resolve any merge conflicts, and give the result a code assessment. Get it to a merge-ready state." },
      { name: "merge", desc: "Merge worktree back into main", expansion: "The work in the worktree is good. Merge back into main and clean up. Remove the worktree, branch, and any files it might've created in ~/.config/exocortex/instances/ and ~/.config/exocortex/runtime/ as a result of being a worktree after confirming a sucessfull merge" },
    ],
  },
];

// ── Derived exports ──────────────────────────────────────────────

/** Autocomplete entries for macros (base names only — args appear after selecting the base command). */
export const MACRO_LIST: CompletionItem[] = MACROS.map(m => ({ name: m.name, desc: m.desc }));

/** Expansion text for each macro, keyed by "/name" or "/name arg". */
export const MACRO_MAP: Record<string, string> = Object.fromEntries(
  MACROS.flatMap(m => [
    [m.name, m.expansion],
    ...(m.args ?? []).map(a => [`${m.name} ${a.name}`, a.expansion]),
  ]),
);

/** Sub-argument lists for macros that have them (used by autocomplete and prompt highlighting). */
export const MACRO_ARGS: Record<string, CompletionItem[]> = Object.fromEntries(
  MACROS
    .filter(m => m.args && m.args.length > 0)
    .map(m => [m.name, m.args!.map(a => ({ name: a.name, desc: a.desc }))]),
);

// ── Expansion ─────────────────────────────────────────────────────

/**
 * Expand macro commands in user message text.
 *
 * Tries "command + arg" first (e.g. "/commit exocortex"), then falls
 * back to the bare command (preserving unrecognized arg words).
 * Only matches at word boundaries (start of line or after whitespace).
 */
export function expandMacros(text: string): string {
  return text.replace(/(?<=^|\s)(\/[\w-]+)(?:[ \t]+([\w-]+))?/gm, (_full, cmd, arg) => {
    if (arg) {
      const withArg = cmd + " " + arg;
      if (MACRO_MAP[withArg]) return MACRO_MAP[withArg];
    }
    if (MACRO_MAP[cmd]) {
      return arg ? MACRO_MAP[cmd] + " " + arg : MACRO_MAP[cmd];
    }
    return arg ? cmd + " " + arg : cmd;
  });
}
