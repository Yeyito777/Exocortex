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
  tool hints, the app-wide `config/system.md` addendum, folder and
  conversation instructions, and a scoped subagent's role note. The prompt is
  rendered for each new Claude Code process instead of reusing the session's
  recorded one, so edits apply once the running process (see background tasks
  below) has closed. Goal text is left out because the `goal` tool is not
  offered to Claude Code. `/system` shows the appended text.
- Exocortex's own tools are not used either, except `chrono`. Claude Code calls
  it over an in-process MCP server as `mcp__exocortex__chrono`; Exocortex runs
  it like any other chrono call, and history records it as `chrono`. Sleeps
  and waits run inside the call for at most five minutes, since a Claude Code
  turn cannot be suspended; longer delays use a wake with a message. Claude
  Code's own schedulers (`ScheduleWakeup`, `CronCreate`, `CronDelete`,
  `CronList`) are disabled in favor of chrono.
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
- **Background tasks.** Claude Code runs `run_in_background` shells and
  background agents inside its own process, so a turn that leaves any running
  keeps that process:
  - they show as the conversation's background tasks (sidebar badge, Tasks UI)
    and can be stopped there;
  - later turns send their messages into the same process, and interrupting a
    turn stops only the turn, as in Claude Code;
  - when a task finishes, Claude Code starts a turn of its own. Exocortex queues
    a `[notification] Background task completed` message for it and shows that
    turn's work.

  Even without background tasks a process stays 15 seconds after its turn
  ends or is interrupted, so queued messages, steering and quick follow-ups
  continue in it instead of starting and resuming a new one. It closes once it
  has had no task or turn for that long, or when the model, effort or
  workspace changes, history is rewound past it, or the daemon stops or
  restarts. Its tasks end with it; a resumed session reports them as stopped.

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
- Every send checks `claude auth status` and refuses unless it reports a
  `claude.ai` login.
- If Claude Code reports that a turn is running on extra usage (overage), the
  turn is stopped.

The five-hour and seven-day subscription windows reported by Claude Code feed
Exocortex's usage display.

## Setup

```
claude auth login            # once, in a terminal (or /login anthropic)
/model anthropic opus
```

`/logout anthropic` disconnects Exocortex only; the Claude Code CLI stays signed
in. Set `CLAUDE_CODE_BIN` if `claude` is not on the daemon's `PATH`,
`~/.local/bin`, or `~/.claude/local`.
