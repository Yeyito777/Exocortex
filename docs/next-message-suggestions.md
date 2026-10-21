# Next-message suggestions (experimental)

After a turn ends, a cheap model predicts what you will type next and the TUI
shows it as dim ghost text in the empty prompt. Typing anything hides it;
Right Shift, `→`, or Tab in normal mode puts it in the prompt to edit or send with `Enter`. It is
never sent on its own.

## Enabling

Off by default. Enable it in the daemon host's `config/config.json` and restart
the daemon:

```json
{ "experimental": { "nextMessageSuggestions": true } }
```

Clients learn the flag from the daemon's `tools_available` bootstrap
(`experimental.nextMessageSuggestions`) and only react to the daemon's events,
so it works over `/ssh` without client configuration.

## When a suggestion is made

`daemon/src/next-message-suggestions.ts` runs after a turn ends cleanly and
hands the prompt back: not after errors, aborts, Chrono sleeps, manual
compaction, or a turn that hands off to a queued message or goal continuation.
It skips subagent conversations and conversations no client has open. A new
turn cancels a pending prediction and clears the current one; a prediction
that a new message overtook is dropped.

The request goes to the conversation provider's title model (Claude Haiku 5.5
for Anthropic, GPT-6 Luna for OpenAI; see `titleModelForProvider`) at the
lowest effort, with a fixed system prompt and up to ~8,000 characters of the
recent transcript: human messages, assistant reply text (no thinking or tool
output), and automated notices. Replies that are empty, `NONE`, multi-line,
over 160 characters, in the assistant's voice, or bare praise are discarded.
Token usage is recorded under the `next_message_suggestion` source (`/tokens`).

## Protocol

`next_message_suggestion { convId, text: string | null }` goes to the
conversation's subscribers when a prediction is ready (`text`) and when a new
turn starts (`null`). `load_conversation` and `subscribe` send the current
value (possibly `null`) to the requesting client after the load.

## TUI

`tui/src/nextmessage.ts` draws the suggestion when the prompt is focused and
empty (no pending images or voice input) and the conversation is not
streaming. Accept keys:

- Right Shift, in insert and normal mode: st sends `ESC ] 777 ; right-shift
  BEL`, Mac Terminal's fallback is `ESC [ 29 ~`, and the Mac over `/ssh` sends
  F20 (`ESC [ 19 ; 2 ~`). st also sends F20 for Ctrl+7, which outside insert
  mode jumps to the seventh sidebar conversation; while a suggestion is
  visible, it accepts instead.
- `→`, which does nothing else in an empty prompt.
- Tab in normal mode, where it is otherwise unbound (insert-mode Tab still
  completes or inserts a soft tab).

Accepting is one undo step.
