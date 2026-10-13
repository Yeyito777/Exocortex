# Inline images

Conversation history shows two kinds of images inline: images a model attaches
to its message with the `attach` tool, and images the user pasted.

## Enabling (experimental)

Off by default. Enable it in the daemon host's `config/config.json`:

```json
{ "experimental": { "images": true } }
```

The daemon reads the flag once at start, so restart it after changing the flag.
Clients learn it from the daemon's `tools_available` bootstrap
(`experimental: { images }`), never from their own config, so it works over
`/ssh`; a running TUI picks it up when it reconnects. When off, the `attach`
tool is offered to no provider (native or Claude Code), `get_image` answers
with an error, and the TUI renders history as before (pasted images keep their
📎 badge). `EXOCORTEX_TUI_IMAGES=off` turns images off in one TUI regardless.

## attach tool

`attach { paths: string[] }` (1–8 local PNG/JPEG/GIF/WebP files on the daemon
host) copies each file into `<dataDir>/attachments/<sha256>.<ext>`
(`daemon/src/attachments.ts`), downscaling anything over 4096 px or 8 MB.
Validation is all-or-nothing. The result is persisted on the `tool_result`
content block as `attachments: ImageRef[]` and projected to clients as
`ToolResultBlock.images`. Provider request builders ignore the field: the model
only sees the text receipt, never the pixels, on this or later turns (it can
`read` the file to look). Under Claude Code the tool is an MCP host tool; the
refs travel beside its text result in-process
(`providers/anthropic/host-tool-attachments.ts`).

The TUI draws attached images after the whole visible assistant message, just
above its metadata line. Pasted images are drawn under the user's bubble.
Inline images are thumbnails (at most 56 columns × 12 rows, aspect preserved,
never enlarged) with no caption: the viewer shows the name or type,
resolution, and size, and a pasted image's bubble already has its 📎 badge.
Several images in one message form a strip: side by side with a 2-column gap,
each fitted to those limits on its own so images of one shape share a height,
bottom-aligned. When they don't all fit the chat width, as many as fit are
shown, followed by `› +N` beside them. Kitty strip rows are filled with
no-break spaces, so the history cursor can cross them like text. While an
image has no pixels its first row says "loading image…" or why it is
unavailable, cut to the image's width (beside an assistant image, to the
pane): history rows are drawn as built, so a row wider than the pane would
wrap into the sidebar. Image rows are also clipped to the pane when drawn.

Enter on a thumbnail with the history cursor, or a click on it,
opens the full-size viewer (`tui/src/imagemodal.ts`) on that image; `› +N`
opens it on the first hidden one. The viewer is a centered box sized to the
image and the terminal. With several images, `j`/`l`/`→` and `k`/`h`/`←` page
to the next and previous image of the same message, stopping at either end;
the footer shows the position (`2/5`) and the next image is fetched ahead.
Enter, Esc, `q`, or a click close it. It sits on top of the screen: thumbnails
stay where they are, and one it partly covers keeps the part outside the box
(up to four cropped placements around it), so closing it only has to restore
what it covered. In st the thumbnail under the history cursor is tinted
(`V=1`), also while the viewer is open. The history projection adds `imageId`
(sha256), `width`, and `height` to pasted `ImageAttachment`s so they stay
fetchable after the payload is compacted.

## Previews

History never carries image bytes for attachments. Clients request
`get_image { imageId, convId?, format, width, height }` and receive
`image_data`: a PNG fitted to the box (never upscaled) or exact-size RGBA for
character cells. A pasted image is found in its conversation on first request
and then copied into the store. Previews are rendered by ImageMagick and cached
in memory.

Pasted images are also copied into the store when `send_message`,
`queue_message`, or `update_queued_message` arrives, because a turn stores its
user message only after loading the conversation and a client asks for its own
paste right away. A pasted PNG whose bytes the TUI still holds (its local echo,
or history that carries the payload) goes to Kitty terminals as is, with no
`get_image` at all (up to 16 MB of base64, 1 MB when the TUI's own terminal is
reached over SSH). The TUI shows "loading image…" while a preview is pending and
retries, with backoff for about 8 s, a pasted image the daemon reports not found
and any request that timed out; other errors show as "image unavailable".

## Context compaction

Pasted images count toward a conversation's context by what the provider bills
for them, not by their payload size: OpenAI by tiles, Claude by pixels (about
width × height / 750 tokens after downscaling to a 2576 px long edge, at most
5,000 tokens). A history too large for one summary request is summarized in
textual segments; each image in it becomes a reference to its stored copy
(`image_id`, `path` in the attachment store, type, dimensions, size) that the
checkpoint keeps beside what the conversation says about it, so the model can
open the file again. The newest user messages are kept verbatim beside the
checkpoint, images included. If an automatic compaction before a turn or
between tool rounds still fails, the turn continues uncompacted with a
warning; an actual context-window error still triggers its own compaction,
and if that fails the turn ends with an error that keeps the message for
`/replay`. Claude Code conversations compact differently (see
[anthropic.md](anthropic.md)).

## Terminal rendering

`tui/src/terminalgraphics.ts` detects Kitty graphics with an `a=q` query
followed by DA1, and the cell size with `CSI 16 t`. Inside tmux the fallback is
used without a query. `EXOCORTEX_TUI_IMAGES=kitty|halfblock|off` overrides.

- Kitty mode reserves blank rows; every frame `historyimages.ts` finds the
  image rows on screen, crops each image to its visible run of rows, and
  `kittyimages.ts` reconciles placements (direct `t=d` transmission in 4096-byte
  chunks, `a=p` with source crop, `a=d` for placements that left). The frame
  renderer's scroll-region optimization is disabled while images are placed.
  The task panel and autocomplete crop images; the queue prompt and the
  conversation menu hide them; the image viewer (`z=2`) and the edit-message
  menu (Ctrl-W) crop them to what lies outside their box, so closing either
  only restores what it covered.
- The fallback draws `▀` cells from the RGBA preview.

The image box is identical in every mode, so loading pixels or switching modes
never moves text.
