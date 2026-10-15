# Several Claude accounts

Exocortex can run Claude conversations on more than one Claude subscription
(for example two Max plans owned by the same person). Each account is its own
Claude Code configuration directory, which is Claude Code's documented way to
stay signed in to several accounts ("Log in with multiple accounts" in Claude
Code's authentication docs). Exocortex only chooses which directory a Claude
Code process starts with (`CLAUDE_CONFIG_DIR`). It never reads, copies,
prints or forwards the OAuth tokens in those directories. Each account signs
in through Claude Code's own login, and Claude Code refreshes its own tokens.

Code: `daemon/src/providers/anthropic/accounts.ts` (registry and directories),
`routing.ts` (decisions), `account-pool.ts` (runtime state, combined usage),
`auth-cache.ts` (sign-in checks), `usage.ts` (per-account usage).

## Accounts

- **`main`** is the existing login, whatever directory Claude Code uses
  without help (normally `~/.claude`). Exocortex sets no `CLAUDE_CONFIG_DIR`
  for it.
- Every other account is a directory, by default `~/.claude-<name>`. When it
  is added, Exocortex links the main directory's `projects/` (Claude Code
  sessions), `settings.json`, `CLAUDE.md`, `skills/`, `agents/`, `commands/`,
  `plugins/`, `output-styles/`, `hooks/` and `statusline-command.sh` into it,
  where they exist. Sessions therefore resume on any account, and every
  account runs with the same settings. The login (`.credentials.json`,
  `.claude.json`) stays in each directory.
- The registry is `anthropic-accounts.json` in the instance's data directory.

```
/account claude                       # every account: sign-in, limits, usage, warm conversations
/account claude add max2              # create ~/.claude-max2 and register it
/account claude add max2 <dir>        # use another directory
/account claude remove max2           # unregister (the directory and login stay)
```

`/accounts` (or `g a` in normal mode) opens the Accounts screen once more than
one account is set up. It covers the terminal with one card: the combined
5-hour and weekly bars (as a share of every account's capacity) and where new
work goes, then each account's sign-in, plan and state, its own 5-hour and
weekly windows with their reset times, and the conversations on it. Running
turns and the current conversation get a row each; more than two warm-cache
conversations fold into one row that Enter expands. A signed-out account
shows its login command. It updates live while open; j/k select a row, Enter
opens a conversation (or expands the warm ones), Esc or q closes.
The daemon's `accounts` command carries the same data
([direct daemon commands](daemon-ipc.md)).

After `add`, sign the account in from a terminal with Claude Code's own login.
`/account claude add` prints the exact command:

```
CLAUDE_CONFIG_DIR=~/.claude-max2 command claude auth login --claudeai
```

(`command` skips shell aliases such as `claude --permission-mode …`.) Running
`CLAUDE_CONFIG_DIR=~/.claude-max2 claude` and using `/login` inside it works
too. Then run `/account claude` to check that it shows `ready`.

## Which account runs a turn

Decisions happen at turn boundaries, never mid-turn
(`routeClaudeTurn`, `routing.ts`):

1. **A conversation stays on its account** while any of these hold:
   - its Claude Code process has background tasks (moving would stop them);
   - its process is still open (it closes 15 seconds after an idle turn);
   - its prompt cache is warm: less than an hour since its last request.
     The cache belongs to the account's organization and does not carry
     over. Claude Code 2.1.x writes the main conversation's cache with a
     one-hour TTL on a subscription within its limits (its `promptCacheTtl`
     setting: "Unset = automatic: 1 hour on a Claude subscription"; SDK
     turns count as the main conversation), sometimes five minutes, so one
     hour is the safe bound.

   The exception is an account that cannot serve the turn at all: signed out,
   failing authentication, or rejected at a usage limit. Then the
   conversation moves (unless background tasks pin it, or no other account can
   take it).
2. **A conversation whose cache is cold** moves only when that clearly helps:
   its account is below a floor (under 10% left in its 5-hour or weekly
   window), or another account's weekly window resets more than 6 hours
   sooner. The next turn rewrites the cache wherever it runs, so a cold move
   costs nothing extra.
3. **New conversations, exo subagents and helper requests** (titles,
   summaries, compaction) go to the account whose capacity expires soonest,
   among accounts that are signed in, not limited, and above both floors:
   - soonest weekly reset first. Unused capacity is lost at a reset, so the
     account that resets soonest is burned first and the one whose capacity
     lasts longer is saved ("first expired, first out", the same idea as
     claude-swap's `consume-first` strategy). The weekly window decides first
     because it is the scarcer one;
   - weekly resets within 6 hours of each other count as a tie, broken by the
     soonest 5-hour reset (within 30 minutes counts as a tie);
   - then the most headroom (the smaller of the two windows' remaining
     percent), then the fewest running turns, then account order.

   A window with nothing used has not started, so its capacity cannot expire
   yet; it ranks last. If every account is below a floor, work still runs, on
   the account with the most headroom left.
4. Subagents do not inherit their parent's account; each is placed by rule 3.

A conversation that moves shows a notice in its transcript, for example
`Claude account switched from "main" to "max2": "main" is at a usage limit.`
Its Claude Code session resumes from the shared `projects/`. If that resume
fails on the new account, Exocortex replays the conversation into a fresh
session, as for any failed resume. Verified live (Claude Code 2.1.x, Oct 2026):
a session written on one account, including thinking blocks signed for that
account's organization, resumes on the other account in both directions
without error, so the fallback is not needed for a move.

The log names each decision and why, for example
`Claude account max2 for <conv> (new: "main" is below the weekly floor)` or
`conversation <conv> moves from Claude account max2 to main (cold-move: …)`.

With one account, or under [/proxy](provider-proxy.md), every turn runs on
`main` and nothing above applies.

## Limits and blocked accounts

- A `rate_limit_event` with `status: "rejected"` (or a turn that moved onto
  extra usage, which Exocortex stops) marks the account limited until the
  reported reset. An allowed request clears it. A limited account takes no
  turns but still counts in the usage bars at its full share.
- A turn that fails authentication on an account keeps that account out of
  routing for 15 minutes when there are other accounts, then its sign-in is
  checked again. Signed-out accounts take no turns.

## Testing routing live

Real usage cannot be moved, so a test daemon can steer routing with a JSON
file named by `EXOCORTEX_DEV_CLAUDE_ROUTING` (dev/test only; unset, nothing
changes). It is read again at every routing decision, so a test can edit it
while the daemon runs, and it changes only what routing sees: the usage bars
and `/account claude` keep showing real usage
(`routing-dev-overrides.ts`).

```json
{
  "policy": { "cacheTtlMs": 20000, "weeklyFloor": 15, "fiveHourFloor": 10 },
  "accounts": {
    "main": { "usage": { "fiveHour": { "utilization": 20, "resetsInMs": 7200000 },
                         "sevenDay": { "utilization": 95, "resetsInMs": 3600000 } } },
    "max2": { "limitedForMs": 600000 }
  }
}
```

`policy` takes any `RoutingPolicy` field (`routing.ts`). Per account, `usage`
replaces its usage snapshot (windows take `resetsAt` or `resetsInMs`),
`limitedForMs` / `limitedUntil` mark it rejected at a limit, and
`available: false` treats it as signed out or blocked. Start a worktree's
daemon with it, for example
`EXOCORTEX_DEV_CLAUDE_ROUTING=/tmp/routing.json bun run src/main.ts` in
`daemon/`, after copying the main instance's `anthropic-accounts.json` into the
worktree instance's data directory. The daemon logs a warning when it is
active.

## Sign-in checks

Claude Code's short-lived commands such as `claude auth status` can start an
OAuth refresh and exit before saving it, which leaves the login expired
(anthropics/claude-code#95822). Exocortex therefore checks each account's
`claude auth status` at most every 10 minutes (every minute while signed out,
so a new login shows up), and not before every turn. A turn that reports usage
counts as a fresh check. `/account claude` and `/login anthropic` check right
away.

## Usage bars

The 5-hour and weekly bars show the combined usage of the accounts that are
signed in and not blocked: each account adds 100%, so two accounts fill a
0–200% bar (`137/200%`). Next to each bar, "resets in" lists the accounts'
reset times, soonest first, at most two (`resets in 1h20m · 3h05m`,
`resets in 3d · 5d`). With one account the bars are unchanged.
`/account claude` shows each account's own windows.

Idle usage comes from Claude Code's `/usage` data, fetched per account with a
bare Claude Code process for that account (at most once a minute per account,
only when a client connects or a turn ends). During turns, each
`rate_limit_event` updates the account it came from.

## Gaps

- **/proxy** (a Mac using whale's Claude login) always uses whale's `main`
  account, and the Mac's bars show that account's usage. Routing a proxied
  conversation to another whale account would need an account field in the
  link protocol; it is not built.
- **macOS.** Claude Code keys the macOS Keychain entry to `CLAUDE_CONFIG_DIR`,
  so a Mac daemon with its own accounts works the same way: sign each one in
  with the command above on the Mac.
- An API-key profile (the Max plan's monthly API credits) would be another
  kind of account in `accounts.ts` that injects a key from `secrets` instead
  of a config directory. It is not built; subscription accounts reject API
  keys (see [Anthropic](anthropic.md)).

## Terms

Claude Code's documentation supports signing in to several accounts, one
configuration directory each, with the unmodified Claude Code. Exocortex keeps
to that: only the owner's own paid accounts, official Claude Code only, no
token handling, no synthetic "window warming" traffic, every account still
stops at its own limits, and every move is announced in the transcript.
Placing new work on another account automatically is Exocortex's own policy,
not something the documentation describes. Anthropic's usage policy
effective Nov 12 2026 forbids creating multiple accounts to circumvent
guardrails or restrictions, so keep the accounts personal, never share one or
lend its capacity to anyone else, and see `/account claude` for what each is
doing.
