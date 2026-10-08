# Anthropic (Claude Code)

The `anthropic` provider runs Claude through the locally installed Claude Code
CLI, via the Claude Agent SDK. Exocortex becomes a Claude Code front end for these
conversations:

- Claude Code runs its own agent loop with **its** system prompt, built-in tools
  (Bash, Read, Edit, Write, Grep, WebSearch, Task, …), settings, `CLAUDE.md`,
  MCP servers and skills, exactly as `claude` would when started in the
  conversation's workspace directory. Exocortex's own tools and system prompt
  are not used.
- Tools run unattended (`bypassPermissions`); `AskUserQuestion` is disabled
  because Exocortex has no way to answer it mid-turn.
- Each completed turn records its Claude Code session. The next turn forks that
  session at the turn's last entry, so editing or trimming history in Exocortex
  stays consistent. History Claude Code never saw (other providers' turns, an
  aborted partial, an Exocortex compaction checkpoint) is sent as a transcript.
- Tool rounds are stored as normal `tool_use`/`tool_result` messages, so a
  conversation can switch to another provider afterwards.

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
