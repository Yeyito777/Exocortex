# Gemini (Antigravity CLI)

The `gemini` provider runs Google's Gemini models on a Google AI Pro or Ultra
plan, through the **Antigravity CLI** (`agy`), Google's official agent CLI,
over its [Agent Client Protocol](https://agentclientprotocol.com) server
(`agy acp`). Exocortex is a front end for it, as it is for Claude Code
([anthropic](anthropic.md)).

## Why this route

Researched Nov 22 2026, on a Google AI Pro (student) plan:

- **Gemini CLI's "Sign in with Google" is gone for these plans.** Google
  stopped serving Gemini CLI and Gemini Code Assist for individual, Google AI
  Pro and Google AI Ultra accounts on June 18 2026
  ([deprecation notice](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals))
  and points them at the Antigravity family. The old `~/.gemini/oauth_creds.json`
  from Gemini CLI is unused.
- **Using a CLI's Google login from other software is banned.** The Gemini CLI
  terms call reaching its services from third-party software with its OAuth
  "a policy-violating use case" that can get the account suspended, and Google
  suspended accounts (AI Pro subscribers among them) for doing so with
  Antigravity's login in February 2026. So Exocortex never touches the CLI's
  token or calls Google's private Cloud Code API itself.
- **A Gemini API key or Vertex AI bills per token**, outside the plan.
- **The Antigravity CLI is the plan's own programmatic surface.** Its headless
  mode and its ACP server are documented for scripts and editors
  ([headless](https://antigravity.google/docs/cli/headless),
  [ACP](https://antigravity.google/docs/cli/acp)), and it signs in with the
  Google account and draws on the plan's quota. Exocortex runs that official
  binary and talks the documented protocol, as it runs Claude Code through the
  Agent SDK.

ACP rather than headless `-p`: it keeps one process per conversation, takes
images, appends to the system prompt (`_meta.antigravity.systemPrompt.append`),
takes per-session MCP servers, and can load a saved session.

**Cost.** Nothing beyond the plan. Requests go through the CLI's Google
sign-in; `GEMINI_API_KEY`, `GOOGLE_API_KEY` and the Vertex/Cloud switches are
stripped from its environment. The CLI's AI-credit overage (`useG1Credits`)
is off by default and Exocortex never turns it on: at a limit, turns wait.

## Models

Live from `agy models` (one id per model and thinking level; Exocortex shows
one model per family and the levels as its efforts):

| Model ID | Alias | Efforts |
| --- | --- | --- |
| `gemini-4-neon` (default) | `neon` | low, medium, high (default), xhigh |
| `gemini-4-hydrogen` | `hydrogen` | low, medium, high, xhigh |
| `gemini-4-argon` | `argon` | low, medium, high |
| `gemini-3.8-flash` | `flash` | low, medium, high (titles and summaries, at low) |

Gemini 4 Carbon is not offered to a Pro account (it is Ultra-only in the
Gemini app; the CLI does not list it). The plan's Claude and GPT-OSS models in
the CLI are left out: Claude runs on the Claude subscription. Context is
1,048,576 tokens.

## Limits

The CLI's `/usage` screen is the only place the plan's quota shows. Gemini
models (Neon, Hydrogen, Flash) share a **five-hour** and a **weekly** limit
(the five-hour one refills until the weekly one is spent); Argon has a smaller
weekly limit of its own on Pro. Exocortex reads that screen by opening the CLI
in a pseudo-terminal at most every three minutes, after turns, and shows the
shared Gemini windows as the usage bars. A turn the plan refuses waits for the
reset, like a Claude turn at a limit.

## How a turn runs

- **The agent is the CLI's.** Its system prompt, built-in tools (`run_command`,
  `read_file`, `replace_file_content`, `grep_search`, `search_web`, ...),
  GEMINI.md/AGENTS.md and skills, in the conversation's workspace. Exocortex
  appends what it appends to Claude Code (`buildClaudeCodeSystemAppend`):
  external tool hints, the app-wide and conversation instructions. `/system`
  shows it.
- **Exocortex's host tools** (`exo`, `chrono`, `goal`, `client_bash`,
  `remote_bash`, `attach`) reach it as an MCP server, `mcp-bridge.ts`, which
  the CLI starts per session and which forwards each call to the daemon over a
  unix socket (`bridge.ts`), where the turn's tool executor runs it. History
  records them under their own names. Chrono sleeps and waits run inside the
  call (at most five minutes), as for Claude Code.
- **A PreToolUse hook gates the CLI's own tools.** The CLI's hooks are global,
  so the daemon keeps one entry, `exocortex`, in `~/.gemini/config/hooks.json`
  (the owner's own hooks are kept). It does nothing outside Exocortex (empty
  output is no decision); in an Exocortex process it asks the daemon, which
  applies the safety denylist (mapped onto bash/read/write/edit/grep/glob/browse)
  and refuses the built-ins Exocortex replaces: `invoke_subagent`,
  `define_subagent`, `manage_subagents`, `browser_subagent` and `send_message`
  (use `exo`), `schedule` (use `chrono`), `ask_question` and the permission
  prompts (nobody can answer mid-turn). Tools otherwise run unattended
  (`--dangerously-skip-permissions`).
- **Tool rounds commit as they finish**, as Claude Code's do: a round goes to
  the store when its last open call completes, so an interrupted turn keeps
  what ran.
- **Sessions.** One `agy acp` process per conversation stays 30 minutes after
  its turn (at most 6 idle), so follow-ups continue in it. The CLI saves each
  session and can load it again but not fork it, so each committed round and
  turn records the session and a fresh mark, and `gemini-session-heads.json`
  (data directory) remembers each session's newest mark. A turn whose latest
  mark is still its session's newest continues that session (in the running
  process, or loaded into a new one after a daemon restart) and sends only
  what came after; an edit or rewind, a new workspace, or history from another
  provider starts a new session with the earlier history as a transcript.
  `/trim` leaves the session's copy alone; `/compact` starts a fresh session
  from Exocortex's checkpoint.
- **Steering** a running turn interrupts it (the CLI takes no input mid-turn)
  and sends the steer with the rest as the next prompt.
- **Images** go to the CLI as ACP image blocks.

## Sign-in

```
exocortexd login gemini     # in a terminal: runs `agy acp --login`
exocortexd logout gemini    # disconnects Exocortex; the CLI stays signed in
exocortexd doctor           # shows the CLI, its version and whether it is signed in
```

Install the CLI with `curl -fsSL https://antigravity.google/cli/install.sh |
bash` (it installs `~/.local/bin/agy` and updates itself; set
`providers.gemini.binary` in `config/config.json` for another path). The sign-in
prints a Google link and reads back the code the page shows, so it needs a
terminal; `/login gemini` in the TUI says so. A daemon that finds the CLI
already signed in adopts it, as it adopts a Claude Code login. The CLI keeps
its token in `~/.gemini/antigravity-cli/` (Linux) or the keychain (macOS);
Exocortex checks only that the file exists, and otherwise runs `agy models`,
which fails without a sign-in.

## Not supported

- **/proxy.** Carrying Gemini over another machine's login would mean lifting
  the CLI's Google token into Exocortex's forwarder, the use Google's terms
  forbid. Sign in on each machine instead.
- **API-key or Vertex billing**, on purpose (see Cost).
