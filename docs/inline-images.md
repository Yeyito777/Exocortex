# Inline images

Conversation history shows two kinds of images inline: images a model attaches
to its message with the `attach` tool, and images the user pasted.

## Availability

Always on. `EXOCORTEX_TUI_IMAGES=off` turns images off in one TUI (history then
renders as before inline images; pasted images keep their 📎 badge). The former
`experimental.images` config flag is ignored; daemons still send
`experimental: { images: true }` in the `tools_available` bootstrap so older
TUIs that gate on it keep showing images.

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
above its metadata line. They stay in view when the turn's work folds (the
default view): a message delivered into the turn after them (the owner's
next-turn message, a notification) splits the reply, and the images close the
part before it, where Ctrl+O shows them too. They never move to the end of the
final reply: that would make them jump down the screen during the turn and
differ between the two views. The phone app follows the same rule. Pasted images are drawn under the user's bubble.
Inline images are thumbnails (at most 56 columns × 12 rows, aspect preserved,
never enlarged) with no caption: the viewer shows the name or type,
resolution, and size, and a pasted image's bubble already has its 📎 badge.
Several images in one message form a strip: side by side with a 2-column gap,
each fitted to those limits on its own so images of one shape share a height,
bottom-aligned. When they don't all fit the chat width, as many as fit are
shown, followed by `› +N` beside them. Kitty strip rows are filled with
no-break spaces, so the history cursor can cross them like text. While an
image has no pixels its first visible row says "loading image…" or why it is
unavailable, cut to the image's width (beside an image alone on its row, to
the pane), so nothing wraps into the sidebar. In Kitty mode the frame draws
that notice over the blank image rows, so pixels arriving never re-render
history; the fallback writes it into the rows. Image rows are also clipped to
the pane when drawn.

Enter on a thumbnail with the history cursor, or a click on it,
opens the full-size viewer (`tui/src/imagemodal.ts`) on that image; `› +N`
opens it on the first hidden one. The viewer is a centered box sized to the
image and the terminal. With several images, `j`/`l`/`→` and `k`/`h`/`←` page
to the next and previous image of the same message, stopping at either end;
the footer shows the position (`2/5`) and the next image is fetched ahead.
Until an image's full-size preview arrives, the box shows its thumbnail
stretched over it, if the terminal already holds one.
Enter, Esc, `q`, or a click close it. It sits on top of the screen: thumbnails
stay where they are, and one it partly covers keeps the part outside the box
(up to four cropped placements around it), so closing it only has to restore
what it covered. In st the thumbnail under the history cursor is tinted
(`V=1`), also while the viewer is open. The history projection adds `imageId`
(sha256), `width`, and `height` to pasted `ImageAttachment`s so they stay
fetchable after the payload is compacted.

## Pasting images

Ctrl+V reads the clipboard through the terminal (OSC 5522, which also works
over SSH) or, without it, the platform clipboard (AppleScript, xclip,
wl-paste, PowerShell). A copied image *file* attaches the file, never the
generic icon a file manager offers beside it: PNG/JPEG/GIF/WebP within 3 MB as
they are, anything else (HEIC/HEIF, TIFF, an EXIF-rotated or larger photo)
decoded upright into a JPEG within 2000 px (`tui/src/clipboard.ts`, with
ImageMagick, or `sips` on a Mac without it). The content decides, not the
name: HEIC data saved as `.PNG` is still decoded. A file that does not decode,
or several files at once, is an error, not the icon. The st fork does the same
on macOS before the bytes reach the TUI (`macos/pasteboard5522.m`, ImageIO), so
a TUI on another host gets the photo too. File URLs offered over SSH refer to
the client, so they are an error there.

## Previews

History never carries image bytes for attachments. Clients request
`get_image { imageId, convId?, format, width, height, purpose? }` and receive
`image_data`: a PNG fitted to the box (never upscaled) or exact-size RGBA for
character cells. `purpose: "thumbnail"` (history thumbnails) quantizes the PNG
to a 256-colour palette, which keeps screenshots looking the same at about a
quarter of the bytes; the viewer asks without it. A pasted image is found in
its conversation on first request and then copied into the store. Previews are
rendered by ImageMagick and cached in memory and on disk
(`attachments/previews/`, 256 MB, least recently used first), so a restarted
daemon answers without the image or ImageMagick.

The TUI fetches a thumbnail at the largest box it can be drawn at for the
current cell size (56 × 12 cells, fitted), so resizing never fetches again;
smaller boxes let the terminal scale it down. It fetches only thumbnails on
screen, then those within a screen's height above and below, nearest first;
opening a long conversation does not download every image in it.

Pasted images are also copied into the store when `send_message`,
`queue_message`, or `update_queued_message` arrives, because a turn stores its
user message only after loading the conversation and a client asks for its own
paste right away. The `user_message` event echoes a pasted image over 128 KB
of base64 as its id and size only: the sender keeps its own bytes (also for a
queued message delivered later) and other clients fetch a preview. A pasted PNG
whose bytes the TUI still holds (its local echo, or history that carries the
payload) goes to Kitty terminals as is, with no `get_image` at all, when the
terminal would not have to shrink it much (at most 4× the drawn pixel area, at
most 8192 px a side, up to 16 MB of base64, 1 MB when the TUI's own terminal is
reached over SSH). Any other image whose bytes the TUI holds (a larger
screenshot, a JPEG) has its previews rendered by the TUI itself
(`tui/src/localpreview.ts`: ImageMagick, or `sips` on a Mac without it), so
over /ssh a just-sent image's thumbnail never waits for the upload to reach
the daemon; only if that fails is the daemon asked. The TUI shows "loading
image…" while a preview is pending and retries, with backoff for about 8 s, a pasted image the daemon reports not
found and any request that timed out or was cut off by a disconnect; other
errors show as "image unavailable" until a daemon (re)connects.

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
  chunks, `a=p` with source crop, `a=d` for placements that left). After a
  [region scroll](scroll-regions.md) every visible placement is placed again,
  since terminals move or drop placements with the scrolled rows.
  The task panel, autocomplete, image viewer (`z=2`), queue prompt,
  edit-message menu (Ctrl-W), sidebar conversation menu and accounts screen
  crop them to what lies outside their box, so closing one only restores what
  it covered. Images stay resident in the terminal (up to 512 images and
  192 MB of decoded pixels, below st's limits), so scrolling back re-places
  them without sending them again; one the terminal rejects right after
  receiving it three times is no longer placed.
- The fallback draws `▀` cells from the RGBA preview.

The image box is identical in every mode, so loading pixels or switching modes
never moves text.
