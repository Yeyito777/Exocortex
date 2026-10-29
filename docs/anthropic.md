# Anthropic (Claude Code)

The `anthropic` provider runs Claude through the locally installed Claude Code
CLI, via the Claude Agent SDK. Exocortex becomes a Claude Code front end for these
conversations:

- Claude Code runs its own agent loop with **its** system prompt, built-in tools
  (Bash, Read, Edit, Write, Grep, WebSearch, Task, …), settings, `CLAUDE.md`,
  MCP servers and skills, exactly as `claude` would when started in the
  conversation's workspace directory. Exocortex's own system prompt (identity,
  environment, internal tool guidance) is not used.
- Exocortex appends its additions to Claude Code's system prompt: external
  tool hints, the app-wide instructions (`config/system.base.md`, then
  `config/system.md`), folder and
  conversation instructions, and a scoped subagent's role note. The prompt is
  rendered for each new Claude Code process instead of reusing the session's
  recorded one, so edits apply once the running process (see background tasks
  below) has closed. Goal text is left out because the `goal` tool is not
  offered to Claude Code. `/system` shows the appended text.
- Exocortex's own tools are not used either, except `chrono` and `exo`. Claude
  Code calls them over an in-process MCP server as `mcp__exocortex__chrono` and
  `mcp__exocortex__exo`; Exocortex runs them like any other call, and history
  records them as `chrono` and `exo`. The server's instructions make `exo`
  subagents the default for real work and forbid Claude Code's Agent tool
  (see [delegation defaults](delegation-models.md)); `exo` from a Claude
  conversation starts Claude Opus at high effort unless told otherwise. Chrono
  sleeps and waits run inside the call for at most five minutes, since a Claude Code
  turn cannot be suspended; longer delays use a wake with a message. Claude
  Code's own schedulers (`ScheduleWakeup`, `CronCreate`, `CronDelete`,
  `CronList`) are disabled in favor of chrono, and the `Agent` (legacy `Task`)
  tool is disabled in favor of `exo`.
- Tools run unattended (`bypassPermissions`); `AskUserQuestion` is disabled
  because Exocortex has no way to answer it mid-turn.
- Each Claude Code tool round is committed to Exocortex's store as soon as its
  last result arrives, exactly like Exocortex's own tool rounds: persisted
  mid-turn, displayed from canonical entries (so opening a busy conversation
  only streams the unfinished round), and kept if the turn is aborted or the
  daemon restarts. Each round also updates the context and token meters.
- Each committed round and each completed turn records its Claude Code session
  and chain entry. A turn that starts a new Claude Code process forks that
  session at the latest one, so an interrupted turn resumes right after its
  last committed round, and editing or trimming history in Exocortex stays
  consistent. History Claude Code never saw (other providers' turns, an
  aborted partial, an Exocortex compaction checkpoint) is sent as a
  transcript.
- Tool rounds are stored as normal `tool_use`/`tool_result` messages, so a
  conversation can switch to another provider afterwards.
- **Session files.** A fork is a full copy of the transcript up to its resume
  point (same entry ids, a new session id), so a long conversation left one
  25-40 MB file per new process. Resuming in place instead would append to one
  file, but Claude Code then loads only its newest branch, cannot resume the
  entries of a process still running, and cannot reach points from before its
  own compaction, so every new process still forks. Once a day (the first time
  10 minutes after the daemon starts) a separate process prunes
  (`daemon/src/providers/anthropic/session-prune.ts`): per conversation it
  keeps the fewest files that hold every resume point its history records
  (the next turn's, plus one per Claude Code compaction for unwinds past it)
  and deletes the rest of the conversation's files once they are a day old.
  A pruned session id gets an alias in `claude-session-aliases.json` (data
  directory) to the kept file that holds its points; an unwind to one of them
  resumes that file at the same entry, which sends the model the same
  messages. It touches only this instance's conversation workspaces' project
  directories, never a file a running process holds, never an interactive
  `claude` session, and never the `tool-results/` and `subagents/`
  directories later transcripts point into. Claude Code's own sweep would
  delete transcripts 30 days old wherever they are, sessions idle
  conversations resume from included, so at start the daemon sets
  `cleanupPeriodDays` to 3650 in each Claude configuration directory's
  `settings.json` where it is unset (an explicit value stays). By hand:

  ```
  bun daemon/src/providers/anthropic/session-prune-cli.ts           # dry run
  bun daemon/src/providers/anthropic/session-prune-cli.ts --apply   # delete
  ```
- **Context compaction.** Claude Code compacts its own session, from the API's
  real usage: automatically near the window (967k of a 1M window) and when a
  request is still too long. Exocortex shows each such compaction ("Claude
  Code automatically compacted its context (968,000 → 41,000 tokens).") and
  takes the new size for the context meter. Exocortex's own automatic
  compaction runs only on what a turn sends Claude Code as one prompt, history
  its session has not seen, when that would not fit; a resumed session is
  never compacted by Exocortex. If Claude Code still reports the prompt as too
  long, Exocortex compacts its replay and starts a fresh session once. `/compact`
  is Exocortex's compaction and starts a fresh session from its checkpoint.
- **Background tasks.** Claude Code runs `run_in_background` shells and
  background agents inside its own process, so a turn that leaves any running
  keeps that process:
  - they show as the conversation's background tasks (sidebar badge, Tasks UI;
    a background agent as `◆ Agent`, a shell as `$ Bash`) and can be stopped
    there;
  - later turns send their messages into the same process, and interrupting a
    turn stops only the turn, as in Claude Code;
  - when a task finishes, Claude Code starts a turn of its own. Exocortex queues
    a `[notification] Background task completed` message for it and shows that
    turn's work.

  Even without background tasks a process stays 30 minutes after its turn
  ends or is interrupted, so the conversation's next turn (a follow-up,
  steering, a queued message) continues in it instead of starting a new
  process and forking its session (in Oct 2026 about half of the turns that
  started a new process came within 5 minutes of the last one). It closes once it has had no task or turn for
  that long, or when the model, effort, workspace, Claude account,
  instructions or tool text change, history is rewound past it, or the daemon
  stops. Idle processes are capped: past 12 idle ones, or once every live
  process together uses more than a fifth of the machine's memory (measured
  from the relays' process trees; 6 GiB on a 31 GiB machine), the one idle
  longest closes first; a process with a turn or background tasks is
  never closed for room. Its tasks end with it; a resumed session reports them
  as stopped.
- **Daemon restarts.** Each process runs under a small relay
  (`daemon/src/providers/anthropic/relay.ts`) in its own transient systemd
  unit (`exocortex-claude-*`; started detached elsewhere), so a restart,
  even a crash, leaves it and its background tasks running:
  - the restarting daemon lets go of a running turn instead of interrupting
    it, and the conversation shows `✗ Daemon restarted`;
  - the next daemon adopts every process left running. A turn still in
    progress is shown by the conversation's replay, picking up after the last
    tool round the old daemon saved (the relay replays Claude Code's output
    since then), without resending the prompt. Background tasks reappear in
    the Tasks UI and still wake the conversation when they finish;
  - an Exocortex tool call (`chrono`, `exo`) the old daemon was running gets
    an "interrupted because the daemon restarted" result;
  - an adopted process keeps the tools and instructions it started with.
    Interrupting its turn closes it (unless background tasks are still
    running), so the next message starts a fresh one;
  - left without a daemon, a relay ends its idle process after 10 minutes.
- **Network outages.** A turn that cannot reach the API waits for the network
  instead of failing, then resumes the same session after its last committed
  round (see [network outages](network-outages.md)).

  `exocortexd stop` ends the processes. On Windows they still end with the
  daemon.

| Model ID | Alias |
| --- | --- |
| `claude-opus-5-5` | `opus` (default) |
| `claude-fable-5-1` | `fable` |
| `claude-sonnet-5-5` | `sonnet` |
| `claude-haiku-5-5` | `haiku` (titles/summaries) |

Other model ids Claude Code accepts can also be used.

## Billing: subscription only

Requests go through the Claude Code CLI's claude.ai login, so they draw on the
Claude subscription's usage limits:

- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and the
  Bedrock/Vertex/Foundry switches are stripped from Claude Code's environment.
  Under [/proxy](provider-proxy.md), Exocortex itself sets
  `ANTHROPIC_BASE_URL` to its loopback forwarder and `CLAUDE_CODE_OAUTH_TOKEN`
  to the forwarder's secret; the remote machine's Claude Code login is used.
- Sends refuse unless `claude auth status` reports a `claude.ai` login
  (under /proxy, the remote's). The status is cached per account and checked
  at most every 10 minutes, since each `claude auth status` can start a token
  refresh it may not save (anthropics/claude-code#95822); a turn that reports
  usage counts as a fresh check.
- If Claude Code reports that a turn is running on extra usage (overage), the
  turn is stopped.

The five-hour and seven-day subscription windows reported by Claude Code feed
Exocortex's usage display.

## Several Claude accounts

Exocortex can use more than one Claude subscription, each signed in to its own
Claude Code configuration directory. Conversations stay on their account
while their prompt cache is warm, and new work goes to the account whose
capacity expires soonest. The usage bars combine the accounts (two accounts:
0–200%). See [Several Claude accounts](claude-accounts.md).

## Setup

```
claude auth login            # once, in a terminal (or /login anthropic)
/model anthropic opus
```

`/logout anthropic` disconnects Exocortex only; the Claude Code CLI stays signed
in. `/account claude` lists the Claude accounts and adds or removes one. Set `CLAUDE_CODE_BIN` if `claude` is not on the daemon's `PATH`,
`~/.local/bin`, or `~/.claude/local`.
