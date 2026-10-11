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
never enlarged) with a caption row. Enter on a thumbnail or its caption with
the history cursor, or a click on it, opens the full-size viewer
(`tui/src/imagemodal.ts`): a centered box sized to the image and the terminal,
closed with Enter, Esc, `q`, or a click. While it is open it is the only image
on screen; in st the thumbnail under the history cursor is tinted (`V=1`). The
history projection adds `imageId` (sha256), `width`, and `height` to pasted
`ImageAttachment`s so they stay fetchable after the payload is compacted.

## Previews

History never carries image bytes for attachments. Clients request
`get_image { imageId, convId?, format, width, height }` and receive
`image_data`: a PNG fitted to the box (never upscaled) or exact-size RGBA for
character cells. A pasted image is found in its conversation on first request
and then copied into the store. Previews are rendered by ImageMagick and cached
in memory.

## Terminal rendering

`tui/src/terminalgraphics.ts` detects Kitty graphics with an `a=q` query
followed by DA1, and the cell size with `CSI 16 t`. Inside tmux the fallback is
used without a query. `EXOCORTEX_TUI_IMAGES=kitty|halfblock|off` overrides.

- Kitty mode reserves blank rows; every frame `historyimages.ts` finds the
  image rows on screen, crops each image to its visible run of rows, and
  `kittyimages.ts` reconciles placements (direct `t=d` transmission in 4096-byte
  chunks, `a=p` with source crop, `a=d` for placements that left). The frame
  renderer's scroll-region optimization is disabled while images are placed.
  The task panel and autocomplete crop images; modal prompts hide them.
- The fallback draws `▀` cells from the RGBA preview.

The image box is identical in every mode, so loading pixels or switching modes
never moves text.
