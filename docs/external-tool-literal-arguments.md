# External Tool Literal Arguments and Payload Inputs

Status: baseline captured and direct manifest migrations completed 2026-07-30.
This document preserves the original `shell.literalArgs` inventory, adjacent
argv-based payloads, evidence, and remaining cleanup work.

No installed external-tool manifest now declares `shell.literalArgs`.

## Original `shell.literalArgs` declarations

### Discord

| Command | Rule | Freeform value |
| --- | --- | --- |
| `discord send` | `tail` | Final message argument |
| `discord reply` | `tail` | Final reply argument |
| `discord edit` | `tail` | Final replacement-text argument |
| `discord dm --send` | `flag` | `--send` value |

### Exo CLI

| Command | Rule | Freeform value |
| --- | --- | --- |
| `exo send` | `positional: 0` | Message/prompt |
| `exo llm` | `positional: 0` | Prompt |
| `exo llm --system` | `flag` | System prompt |
| `exo queue` | `positional: 1` | Queued message |
| `exo rename` | `positional: 1` | Conversation title |

The positional rules declare their value-taking flags so those flag values do
not count as positional payloads.

### Image

| Command | Rule | Freeform value |
| --- | --- | --- |
| `image generate` | `tail` | Image prompt |

### vimbrowser CLI

| Command | Rule | Freeform value |
| --- | --- | --- |
| `vimbrowser-cli js` | `tail` | JavaScript source |
| `vimbrowser-cli frame-js` | `tail` | JavaScript source |
| `vimbrowser-cli raw` | `tail` | Raw protocol payload |

No other installed external-tool manifest declared `shell.literalArgs` in the
baseline inventory.

## Other argv-based payloads to review

These human-facing payloads have the same general shell-transport concern but
do not currently declare `literalArgs`:

- Twitter: `post`, `reply`, and `dm --send`.
- WhatsApp: `send` message text and file captions.
- Gmail: `send`, `reply`, and `forward` via `--body`. Gmail already falls back
  to stdin when neither `--body` nor `--body-file` is supplied.

The original direct manifest consumers—Discord, image, vimbrowser, and external
Exo—have all migrated to required stdin for their primary opaque payloads.

## How `literalArgs` entered model context (removed)

The raw manifest JSON is not injected into model context.

1. Each external tool contributes its handwritten `manifest.systemHint`.
2. Exocortex calls `getShellConfigHint(toolName, manifest.shell)`.
3. That function converts all `literalArgs` rules for one tool into one
   generated English sentence.
4. `getExternalToolHints()` appends the handwritten hint and generated shell
   hint, then joins entries from all loaded tools into the external-tool prompt
   context.

Therefore the generated guidance was **one sentence per tool**, not one prompt
block per rule. With the original inventory, four generated sentences were
added: Discord, Exo, image, and vimbrowser. No generated literal-argument
sentence is added now that every manifest rule has been removed.

Before the stdin migration, `external-tools/TOOL_STANDARD.md` documented the
manifest feature; that file is not itself injected into model context.

The generated sentence ended with:

> freeform text arguments are treated literally by the bash harness, so
> markdown/code text does not need manual shell escaping.

That wording is broader than the implementation can guarantee and is part of
the payload-input design issue under review.

## Runtime rewrite behavior (removed)

The same manifest rules also controlled Bash-command rewriting:

1. Exocortex splits eligible top-level shell command segments.
2. It tokenizes a simple shell command and identifies the external tool and
   direct subcommand.
3. It locates the configured tail, flag value, or positional token.
4. It replaces that token with a Bash single-quoted literal, escaping embedded
   apostrophes safely.
5. Bash then executes the rewritten command.

This protected content that the tokenizer could identify correctly. It did not
provide a separate payload channel, and it could not recover content after
nested unescaped quotes, backticks, substitutions, or unsupported shell syntax
made the command unparseable. In those cases the segment could remain unchanged,
and Bash could interpret payload text as syntax.

## Observed behavior baseline

- A manually shell-safe inline Discord schema was delivered intact:
  `1532449798823743510`.
- A deliberately unescaped inline fenced schema lost the entire code block:
  `1532450140948926494`.
- Two targeted repetitions failed the same way:
  `1532451473248620634` and `1532451517603254322`.
- Two fresh agents given normal schema-posting tasks delivered intact messages:
  `1532452224259854608` and `1532452448092819496`. Both independently used
  Python `subprocess` argv to avoid embedding the payload in shell syntax.

The targeted failures demonstrate a real transport limitation. The fresh-agent
results do not show that capable agents naturally hit it on every rich message;
instead, they show that agents currently invent a Python argv workaround when
the CLI lacks an obvious safe payload path.

## Migration TODO

- [x] Migrate Discord `send`, `reply`, `edit`, and `dm --send` to required
  stdin.
- [ ] Migrate Twitter `post`, `reply`, and `dm --send` primary payloads to
  required stdin.
- [ ] Migrate WhatsApp message text and file captions to required stdin.
- [x] Migrate image prompts and vimbrowser JavaScript/raw payloads to required
  stdin.
- [x] Migrate external Exo `send`, `queue`, and the primary `llm` prompt to
  stdin; use `--system-file` for the secondary system prompt.
- [ ] Decide whether Gmail should reject inline `--body` after its existing
  stdin path is standardized.
- [x] Remove `shell.literalArgs`, its generated prompt hints, runtime rewrite
  branches, manifest schema, and tests from Exocortex core. The
  `TOOL_STANDARD.md` replacement is complete.

Keep short control metadata such as IDs, recipients, model names, paths,
subjects, thread names, and conversation titles in argv. Commands with valid
bodyless modes, such as attachment-only Discord messages, need an explicit
exception instead of a blanket missing-stdin error.

## Adopted direction

If a command has one primary opaque payload—message, body, prompt, JavaScript,
or raw IPC—it comes from stdin. Everything structural remains argv. Migrated
commands require exact UTF-8 stdin, reject inline payload arguments, and fail on
a missing required payload before external mutation. No `literalArgs` fallback
remains.
