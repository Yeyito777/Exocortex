# Switching models across providers

`/model` (TUI), `set_model` (IPC) and the exo tool's model change can move a
conversation between any two providers mid-conversation: Claude (Claude
Code), GPT (OpenAI/Codex), Gemini (Antigravity CLI), DeepSeek, OpenRouter,
OpenCode. The new model picks up the whole conversation: text, tool calls and
their results (other models' included), images, and the system prompt and
instructions, which Exocortex builds for every turn anyway.

## How it works

Exocortex keeps one canonical history (Anthropic-shaped `ApiMessage`s:
text, image, thinking, tool_use, tool_result) whatever model wrote it. A
switch changes only the conversation's provider and model
(`conversations.ts setModel`); nothing is converted then. Each turn, the
provider adapter maps the canonical history onto its own wire format:

- **Stateless API providers** (OpenAI Responses, and the chat-completions
  family: DeepSeek, OpenRouter, OpenCode) get the whole history natively on
  every request: other models' tool calls become function calls with their
  outputs, images stay images (tool-result images too), up to each
  provider's image cap. Strict APIs require every call to be answered just
  after it; `pairToolCalls` (`daemon/src/providers/handoff.ts`) gives an
  unanswered call (an interrupted round from an agent CLI) a placeholder
  result and drops a result whose call is missing. OpenAI reasoning and
  native compaction items are replayed only to the same OpenAI account/model
  scope (`context-compaction.ts`).
- **Agent CLIs with their own sessions** (Claude Code, the Antigravity CLI)
  resume their own latest point in the conversation (Claude Code forks its
  session there; the Antigravity CLI loads it if it is still that session's
  newest point) and get everything after it that they have not seen, usually
  other models' turns, as a transcript ahead of the new message:
  `User:`/`Assistant:` sections with `[tool call NAME ID]` and
  `[tool result ID]` blocks, and the newest 8 images as real image blocks
  where they appeared (`handoffTranscript`). With no point of their own
  (first time on that provider, a new workspace, a rewind) the whole history
  goes as that transcript into a new session. A process that is still
  running (Claude Code keeps one for background tasks and quick follow-ups,
  the Antigravity CLI for 30 minutes) is reused and gets the same transcript
  of the turns it missed (`ClaudeCodeSession.planInput`).
- **An OpenAI-native checkpoint** (after a Codex conversation was compacted)
  is opaque to every other provider and account. On the first turn after
  switching away from that account, the checkpoint's own model rewrites it
  as a plaintext checkpoint (`portableCheckpoint`), which every provider can
  replay; the transcript boundary stays, so the canonical tail after it is
  replayed as before. The chat shows one line: "GPT-6 Sol's compacted history
  was summarised for Claude Opus 5.5." Plaintext checkpoints (Claude's,
  plaintext fallbacks) were already portable.

## What does not carry over

- **Reasoning.** Claude thinking signatures, OpenAI encrypted reasoning and
  Gemini thought text are valid only for the model that wrote them; another
  family never sees them. A model's own reasoning still returns to it
  (Claude via its session, OpenAI via its reasoning items).
- **More than 8 older images into an agent CLI's transcript.** Older ones
  become `[image omitted]`. API providers cap images their own way (OpenAI
  keeps the newest; a provider without image input gets a text note).
- **Exocortex attachments shown with `attach`** are the user's display, not
  model input, as before.
- **Gemini's file reads.** The Antigravity CLI reports no output for
  `read_file` (only for commands), so other models see that call with an
  empty result.

## Why this design (and what T3 Code does)

Researched Nov 23 2026 in [pingdotgg/t3code](https://github.com/pingdotgg/t3code)
(MIT; nothing copied). T3 Code drives agent CLIs (Claude Code, Codex
app-server, ACP agents), so every provider change is a session transition
(`ProviderSessionTransitionPolicy.ts`: reuse, switch model in session,
restart and resume, or create with handoff). A cross-provider switch creates
a new native thread with a *context handoff* (`ContextHandoffService.ts`,
`provider-core/src/server/handoffBudget.ts`):

- It is a budgeted *selection*, not a summary: user and assistant text,
  command executions with exit codes and output, errors, file-change paths.
  Picked in priority order (latest user message, latest assistant message,
  first user message, then newest backwards) under a token cap (default 16k,
  max 64k) and the target's window minus its current use, the new request
  and a work reserve of max(16k, window/4). Bytes count as tokens
  (pessimistic). Omitted items are listed by ID and readable through a
  `t3_thread_read` tool.
- Codex receives the history as native items (`thread/inject_items`);
  others get it inline ahead of the user's text ("User message: ...").
- Going back to a provider whose thread still exists sends only the
  *delta since the target last saw* the conversation, plus images from the
  missed user messages as attachments of the new prompt.
- Reasoning, tool-call state and attachments are not carried. The user's
  new request is never truncated.

Exocortex differs because it is not only a CLI front end: half its providers
are plain APIs it calls itself, with Exocortex's own tool loop. So the
canonical history is the source of truth and is translated natively for
those, which carries far more than a text handoff (real tool calls and
results, images). For agent CLIs it does what T3 Code's delta handoff does,
with real image blocks and tool calls kept in the transcript instead of
dropped. Instead of a fixed budget it relies on the context bounds it
already has: Claude Code and Gemini have 1M windows and compact their own
sessions; for API providers the normal pre-turn compaction applies, and
replay over twice the window refuses rather than truncating silently. The
one thing nothing else can read, an OpenAI-native checkpoint, is translated
by the model that can.

## Tests

- `daemon/src/providers/handoff.test.ts`: provenance, transcripts with
  images, the image cap, Claude Code and Antigravity prompts, tool-call
  pairing for OpenAI and chat completions, and the checkpoint rewrite.
- `daemon/src/providers/anthropic/session.test.ts` ("a running process
  after `/model` away and back").
- `tui/src/commands.test.ts`: `/model <model>` finds the provider.
- `scripts/dev/model-switch-e2e.ts` (paid, on a worktree daemon): Claude →
  GPT → Gemini → Claude with a tool call per model and four images, each
  model answering from the others' tool results and an image no earlier
  answer named; `--restart` (Gemini, daemon restart, Claude), `--checkpoint`
  (GPT, `/compact`, Claude), `--api` (Claude → DeepSeek → OpenRouter →
  Claude), `--gemini-first` (Gemini → GPT → DeepSeek).
