# Several Claude accounts

Exocortex can run Claude conversations on more than one Claude subscription
(for example two Max plans owned by the same person). Each account is its own
Claude Code configuration directory, which is Claude Code's documented way to
stay signed in to several accounts ("Log in with multiple accounts" in Claude
Code's authentication docs). For its own turns Exocortex only chooses which
directory a Claude Code process starts with (`CLAUDE_CONFIG_DIR`). Each
account signs in through Claude Code's own login, and Claude Code refreshes
its own tokens.

One exception: a daemon that lends its Claude logins to another machine
through [/proxy](provider-proxy.md) reads the access token Claude Code stored
for the account a proxied request was routed to (its `.credentials.json`, or
the macOS Keychain item Claude Code keeps for that directory) and puts it in
that request's `Authorization` header. The token never leaves that daemon:
it is not logged, not stored elsewhere, and never sent over the /proxy link.
An expiring token is refreshed by Claude Code itself (a bare usage probe on
that account), so refresh-token rotation stays with Claude Code.

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
one account is set up: a small card with one row per account, Claude's and
OpenAI's, each with a state dot and its 5-hour and weekly bars and the time to
each reset. The account this conversation runs on (OpenAI: the current login)
is highlighted and the one new work goes to is tagged "new work". A limited
account says for how long; a blocked, signed-out or non-subscription one shows
that word instead of its bars. Under the table, a dim note appears only when
it says something the rows do not: that new work skips an account near its
limit, that no account can take it, or the command that signs an account in.
It updates live while open; Esc or q closes.
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
   - its process is still open (it closes 30 minutes after an idle turn,
     inside the cache's hour below, so it pins nothing the cache does not);
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
   window) and another account is above both, or another account scores at
   least 1.25 times its own by rule 3. The margin keeps conversations from
   ping-ponging between accounts at about the same pace. The next turn
   rewrites the cache wherever it runs, so a cold move costs nothing extra.
3. **New conversations, exo subagents and helper requests** (titles,
   summaries, compaction) go to the account furthest behind its weekly pace,
   among accounts that are signed in, not limited, and above both floors.
   The goal is that every account's weekly budget is used up right at its
   own reset, with the accounts burned in parallel rather than one after the
   other:
   - an account's urgency is its weekly headroom divided by the hours until
     its weekly window resets: the burn rate it needs to use the rest by its
     reset. Unused capacity is lost at a reset, so the higher it is, the more
     capacity is at risk. With equal headroom the sooner reset wins; with
     equal resets the account with more room wins; over time the accounts
     converge to the same pace. A window at 0% with a reset time is already
     counting down. One with no reset time, or past its reset, is a fresh
     week: 100% over 7 days from first use;
   - urgency is damped by the 5-hour window: in full from 40% 5-hour headroom
     up, fading linearly to nothing at the 10% floor. An account deep into its
     5-hour window hands new work off before that window blocks, so bursts use
     both accounts' 5-hour windows;
   - scores within 10% of the best count as a tie, broken by the fewest
     running turns (usage readings lag, so a burst of subagents would
     otherwise all land on one account), then the higher score, then account
     order.

   If every account is below a floor, work still runs, on the account with the
   most headroom left.

   For example, with `main` at 0% weekly resetting in 154 hours and `max2` at
   26% weekly resetting in 149 hours, `main` needs 100/154 = 0.65 points an
   hour and `max2` 74/149 = 0.50, so new work goes to `main` until the two
   paces meet, and from then on is shared between them.
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
`Claude account main for <conv> (new: it is furthest behind its weekly pace
(100% left over 6.4 days vs 74% over 6.2 days))` or
`conversation <conv> moves from Claude account max2 to main (cold-move: …)`.

With one account every turn runs on `main` and nothing above applies.

Under [/proxy](provider-proxy.md) the remote daemon routes the proxied
machine's turns across its own accounts with the same rules, per request:
the local daemon names each conversation (`<host>/<conversation id>`), the
remote keeps its assignment as `proxy:<host>/<conversation id>`, and every
response's rate-limit headers update the account that served it. A request
refused at a usage limit is retried once on the account routing picks next,
and an account whose login cannot be refreshed is kept out of routing as
for a failed turn. A move is announced in the proxied conversation's
transcript, as above. The session needs no resume: the local Claude Code
process stays the same and only the login attached on the remote changes.
Rule 1's live-process and background-task pins do not apply to proxied
conversations (moving does not touch the local process); the warm cache
still keeps them in place.

## Limits and blocked accounts

- A `rate_limit_event` with `status: "rejected"` (or a turn that moved onto
  extra usage, which Exocortex stops) marks the account limited until the
  reported reset. An allowed request clears it. A limited account takes no
  turns but still counts in the usage bars at its full share.
- A turn that fails authentication on an account keeps that account out of
  routing for 15 minutes when there are other accounts, then its sign-in is
  checked again. Signed-out accounts take no turns.
- An account's usage comes from its turns' `rate_limit_event`s and from the
  `/usage` poll, which reads about a point higher for the same moment. Within
  one window (same reset time) a report up to 5 points lower keeps the higher
  figure, so the bars never step back; a new window, a bigger drop or a drop
  from 100% to under it takes the report as it is.

## API credits when every account is at a limit

App conversations are routed the same way; an app can keep its turns off
credits or have them stop instead of waiting (`route`, see
[app API](app-api.md#accounts-and-api-credits)).

Each Claude Max plan comes with Claude API credits ($200 a month) that pay for
the Claude API and the Agent SDK, not interactive Claude Code. While every
subscription account is at a usage limit (5-hour or weekly, as routing sees
it; not when they are only signed out), turns run on those credits instead:
the same Claude Code path, model and settings, only authenticated with an API
key. They go back to the subscriptions as soon as one can take work. Helper
requests (titles, summaries, compaction) fall back too. Code:
`daemon/src/providers/anthropic/api-credits.ts`.

```json
"providers": {
  "anthropic": {
    "apiCreditFallback": {
      "enabled": true,
      "strategy": "expiry",
      "minBalanceUsd": 2,
      "keys": [
        { "secret": "ANTHROPIC_API_KEY_MAIN_CREDITS", "label": "main", "account": "main",
          "console": { "org": "<organization uuid>" },
          "grants": [
            { "label": "Max", "amountUsd": 200, "expires": "2026-11-11", "monthly": true },
            { "label": "YC", "amountUsd": 500, "expires": "2027-04-18" }
          ] },
        { "secret": "ANTHROPIC_API_KEY_MAX2_CREDITS", "label": "max2", "account": "max2",
          "console": { "org": "<organization uuid>", "browserContext": "claude-max2" },
          "grants": [{ "label": "Max", "amountUsd": 200, "expires": "2026-11-18", "since": "2026-10-29", "monthly": true }] }
      ]
    }
  }
}
```

- **Keys** are names in the `secrets` store, never values. A key whose
  secret does not exist is skipped (the store is checked every few minutes).
- **Which key a turn takes** (`pickApiCreditKey`, api-credits.ts), among the
  keys that are in the store and not out of credits, rejected or
  rate-limited:
  1. **A conversation stays on its key** while its prompt cache there is
     warm: less than 5 minutes since its last request on it. Each
     organization caches apart, so a move rewrites the whole cache. Claude
     Code on an API key writes the cache with a 5-minute TTL (the one-hour
     TTL is a subscription's; seen in credit turns' usage on 2026-10-29), so
     unlike an account's hour this is short, and an open process pins
     nothing. A process with background tasks keeps its key, as it keeps
     its account. A key that refuses (out of credits, rejected, rate-limited)
     cannot keep anyone.
  2. **New conversations, helper requests and conversations whose cache is
     cold** go to the key whose Console organization has the grant that
     expires soonest with at least `minBalanceUsd` left (grants used up don't
     count), ties in config order. With `main` holding only its YC grant
     (expires in 169 days) and `max2` an untouched Max grant (18 days), new
     work goes to `max2`.
  3. **Config order** instead of rule 2 while any usable key has no recent
     Console figures (never synced, or the last sync over 3 hours old, the
     `≈` on the Accounts screen): the configured `grants` alone are not
     trusted to rank. `"strategy": "order"` always uses config order; rule 1
     applies either way.

  A key with less than `minBalanceUsd` left (default $2) is skipped while
  another has more, warm cache or not; when every key is that low they are
  still used, by the same rules, and the API's refusal ends each one. A move
  between keys is announced to programs only (`api_credits` route event with
  the new `creditKey`; hidden from chat), and the log says why, for example
  `<conv> moves from API-credit key "main" and runs on API credits "max2"
  (…; key: its cache on "main" is cold; its credit expires soonest: $200 in
  18d, vs "main" 169d; …)`. /tokens shows the key new credit turns take and
  why (`New credit turns go to max2 (its credit expires soonest: …)`).
- **The key never reaches an agent.** A local turn gives Claude Code an
  `apiKeyHelper` (`--settings`) that runs `secrets run --allow NAME -- printenv
  NAME`, which Claude Code prefers to the account's subscription login. The
  key is in no environment a Bash tool inherits, and in no log, transcript,
  config or message. The account still picks the configuration directory, so
  sessions resume as usual. Nothing about the SDK's entrypoint or user agent
  changes: these are Agent SDK requests, which the credits cover (checked
  live on 2026-10-29: the Console lists them under Logs as API requests).
- **/proxy**: a remote serving another machine's turns signs their Messages
  API requests with the key (`x-api-key`, without the OAuth beta), counts
  their spend from the response stream, and tells the other machine
  (`x-exocortex-claude-api-credits`), so its turns are marked the same way.
  The other machine takes a Messages answer without that header as served on
  a subscription, and follows only these reports for the move onto credits
  and back (its own route always says `main` with no credits).
  Claude Code's account endpoints keep the subscription login. The other
  machine's daemon must be updated too: an older one keeps waiting for a
  subscription to reset.
- **Out of credits** (the API answers that the credit balance is too low, or
  billing refuses): the key sits out until its next renewal (`renewsOnDay`,
  else its monthly grant's expiry day, else a day; on the renewal day itself it
  is tried every 3 hours until the grant lands), and the turn moves to the next
  key. With none left, the turn waits for a subscription to reset, like any
  usage limit. No key is retried in a loop. A key the API rejects sits out an
  hour; one it rate-limits (429, after Claude Code's own backoff) a minute,
  and the turn is retried at once on another key that has credit (under
  /proxy, the request is retried once on it).
- **/proxy down:** with `"whenProxyDown": { "afterSeconds": 60 }`, a machine
  that sends Claude through /proxy also runs its turns on these keys, directly,
  while the proxy cannot serve it, whether or not it has a login of its own;
  see [provider-proxy.md](provider-proxy.md#api-keys-when-the-proxy-is-down).
  Off when unset. `console` and `account` are optional on a key: without
  `console` there is no sync and the balance is `grants` less counted spend
  (`≈`); without `grants` either, none shows.
- **The spend cap** is the credits themselves: an organization without a card
  or auto-reload refuses requests once they run out.
- **Visibility**: the usage block shows it (neither the turn's metadata line
  nor the transcript notes it; programs get the move as an event and
  `turn_result.billing`, see app-api.md). Which conversations last ran on credits is kept in
  `runtime/anthropic-conversation-credits.json`, so a restart is no move. While turns
  run on them, the status bar's usage bars give way to two rows:

  ```
    Credit: [████████████████████░] $862/$900
    Expiry: $162 12d · $200 19d · $500 170d
  ```

  Credit is everything left over everything granted, across every configured
  key, each Console organization once (`≈` and red as on the Accounts screen,
  "sign-in needed" after it); Expiry lists each grant that has not expired
  with what is left of it (the Console's own figure per grant, less the spend
  counted since the last sync from the one expiring soonest), soonest first.
  When a subscription is back is in /tokens and on the Accounts screen. A
  narrow terminal lists fewer grants (`+2`). An older daemon sends no pool: the bars stay, with "API credits
  max2" / "$199 left" beside them. What turns spend is
  estimated at list prices from the responses' usage and kept in the API-key
  ledger as `anthropic-credits:<secret>`; /tokens shows this cycle's.
- **Accounts screen**: a Credits column per account: the balance, then the
  time until each grant expires, soonest first (`$688 13d · 171d`), bold blue
  with `◀` while a turn spends it, red under a tenth of what was granted,
  with a leading `≈` while it is only an estimate.
- **Real balances** come from the Claude Console (`credit-sync.ts`). The Admin
  API is not offered to individual organizations and an ordinary key cannot
  read the balance, so the daemon asks the way the Console's billing page
  does: a GET of `/api/organizations/<console.org>/prepaid/credits`, made by
  the page itself in a background vimbrowser tab of `console.browserContext`
  (unset: the default context), which must be signed into that account. The
  cookies stay in the browser; Exocortex keeps each grant's remaining amount,
  amount, name and expiry (`runtime/anthropic-credit-sync.json`). Grants are
  discovered there, so renewals and new grants show up by themselves. It syncs
  about hourly, when the fallback starts on a key, and when a key runs out
  (no sooner than 5 minutes apart). Between syncs the balance is the last
  sync's less the spend Exocortex counted since, from the grant expiring
  soonest; a grant past its expiry drops out at once. Only GETs; the org UUID
  is in config, not secrets.
- **When a sync fails** (vimbrowser not running, a timeout, a 401/403, a
  session sent to a sign-in page), the last figures stay, marked `≈` once they
  are over 3 hours old. Before any sync succeeds, the balance is the configured
  `grants` less the counted spend, also `≈` (a `monthly` grant is assumed to
  renew with the same amount on its expiry day; `since` is the day it was first
  credited). One log line per streak of failures, one when it works again; a
  failing organization is tried again hourly, whatever asks sooner. A signed-out
  session shows a muted "sign-in needed" next to the credits; sign that
  vimbrowser context in again by hand (nothing signs in automatically).
- OpenAI's row shows `providers.openai.credit` the same way, always `≈`: it is
  the grant less what Exocortex counted (platform.openai.com was not signed in
  in vimbrowser to read a real one).

## Testing routing live

Real usage cannot be moved, so a test daemon can steer routing with a JSON
file named by `EXOCORTEX_DEV_CLAUDE_ROUTING` (dev/test only; unset, nothing
changes). It is read again at every routing decision, so a test can edit it
while the daemon runs, and it changes only what routing sees: the usage bars
and `/account claude` keep showing real usage
(`routing-dev-overrides.ts`).

```json
{
  "policy": { "cacheTtlMs": 20000, "weeklyFloor": 15, "coldMoveRatio": 1.5 },
  "accounts": {
    "main": { "usage": { "fiveHour": { "utilization": 20, "resetsInMs": 7200000 },
                         "sevenDay": { "utilization": 95, "resetsInMs": 3600000 } } },
    "max2": { "limitedForMs": 600000 }
  }
}
```

`policy` takes any `RoutingPolicy` field (`routing.ts`): `cacheTtlMs`,
`fiveHourFloor`, `weeklyFloor`, `fiveHourComfort`, `scoreTie` and
`coldMoveRatio`. Per account, `usage`
replaces its usage snapshot (windows take `resetsAt` or `resetsInMs`),
`limitedForMs` / `limitedUntil` mark it rejected at a limit, and
`available: false` treats it as signed out or blocked. To try the API-credit
fallback, mark every account limited; turns then run on the first key. Start a worktree's
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

- **/proxy** (a Mac using whale's Claude logins): the Mac shows whale's pool
  as whale does, the combined bars and `/accounts` with whale's accounts,
  usage and where new work goes (`provider_proxy_accounts`,
  [/proxy](provider-proxy.md)). Accounts are added, removed and signed in on
  whale itself (`/account claude` on the Mac says so). A whale daemon older
  than pool routing serves everything from its `main` and shares only that
  account's usage. Processes started before the link reached a pool-routing
  whale (e.g. adopted after a restart) do not name their conversation, so
  their requests are routed as new work.
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
to that: only the owner's own paid accounts, official Claude Code only,
tokens touched only to sign the owner's own /proxy requests on the machine
that holds them (above), no synthetic "window warming" traffic, every account still
stops at its own limits, and every move is announced in the transcript.
Placing new work on another account automatically is Exocortex's own policy,
not something the documentation describes. Anthropic's usage policy
effective Nov 12 2026 forbids creating multiple accounts to circumvent
guardrails or restrictions, so keep the accounts personal, never share one or
lend its capacity to anyone else, and see `/account claude` for what each is
doing.
