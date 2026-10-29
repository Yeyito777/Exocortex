# Video attachments

The `attach` tool takes videos as well as images: MP4, MOV, WebM, MKV, and
animated GIFs. In the owner's st (which plays H.264 + AAC streamed through the
terminal, st's `docs/video.md`) they play inline in history or in the viewer,
with sound, also over `/ssh`. Elsewhere they show as a poster frame.

## Storing

`daemon/src/video-attachments.ts`. The container is recognized by its first
bytes, never the file name; a GIF is a video only when it has more than one
frame (a still GIF stays an image). Up to 1 GB, all-or-nothing like images.

- The file is copied into the attachment store beside images,
  `<dataDir>/attachments/<sha256>.<ext>`, and exports copy it too.
- ffprobe reads its display size (rotation applied), length, frame rate,
  codec and whether it has sound. Videos need `ffmpeg`/`ffprobe` on the
  daemon's host; without them attaching one fails with that reason.
- ffmpeg takes a poster frame (a tenth of the way in, at most 3 s, within
  1280 px) and ImageMagick draws a play badge on it. The poster is an ordinary
  stored image.

The result is the poster's `ImageRef` with `video: VideoRef` set (shared
`messages.ts`): clients that know nothing of video show the badged poster.

## What the model gets

Only text: name, length, size, frame rate, codec, sound and bytes
(`0:12, 1920×1080, 30 fps, H.264 with sound, 3.4 MB`), the poster's path so
it can `read` a frame, and a note that it can't watch the video. No frames are
sent, as with attached images.

## History (TUI)

A video's thumbnail is its poster plus one caption row under it:
`▶ 0:12  space plays here · enter plays big` where video plays, else
`▶ 0:12 video  enter for details`. A yank copies `[video: name · 0:12 · …]`.

The TUI asks st for video with its startup queries: st's `a=v,k=c` query rides
between the Kitty graphics query and DA1 (`tui/src/terminalgraphics.ts`); an
`OK video=h264` answer before DA1 means videos play. `EXOCORTEX_TUI_VIDEO=off`
skips the query. tmux and the half-block fallback never play.

Keys (history cursor on the thumbnail or its caption, normal mode):

| Key | |
|---|---|
| Space | play inline / pause / play again after the end |
| `<` `>` | seek 5 s |
| `x` | stop (the poster comes back) |
| Enter, click | open the viewer, which carries on from where inline playback was |

Inline playback lasts while the thumbnail has a row on screen, in the
conversation it started in, with no viewer open; an inline video that played
to the end gives its sender back after 60 s. One video plays at a time. While
it plays the caption row shows `▶ 0:03 / 0:12 ━━━──── space pause … 1.2 Mb/s
596×336` (what st-play is sending, or `original` when it passes the file's
H.264 through).

The viewer opened on a video plays it at once (once per opening), the poster
placed under it (z=2, the video at z=3) so nothing flashes before the first
frame, with a transport row under the picture. Keys: Space pause/play, ←/→
(h/l) 5 s, ↓/↑ 60 s, 0–9 jump to that tenth, `m` mute, `o` open the file in a
player, `j`/`k` page, Enter/Esc/`q` close (which stops it). Where video can't
play, the viewer shows the poster and `▶ 0:12 video · o opens it in a player`;
`o` opens the stored file through the usual file-link path (over `/ssh` it is
downloaded first, up to 128 MiB).

## Playback

The daemon plays each video with `st-play --pipe` on its own host
(`daemon/src/video-playback.ts`), the sender from st: it transcodes to H.264 +
AAC (or passes 8-bit H.264 through when the link has room), adapts bitrate and
resolution to the measured link, never above the placement's pixels, and keeps
the bytes in flight small so pause and seek act at once.

| Command | |
|---|---|
| `video_play { playbackId, videoId, kittyId, width, height, link, startMs?, volume? }` | start; `link` is `remote` when the terminal is across `/ssh` or SSH |
| `video_input { playbackId, data }` | the terminal's replies about `kittyId`, unchanged |
| `video_control { playbackId, action, value?, width?, height? }` | `pause`, `resume`, `toggle`, `seek`, `skip`, `size`, `volume`, `mute` |
| `video_stop { playbackId }` | stop |

| Event | |
|---|---|
| `video_output { playbackId, data }` | whole APCs for the terminal (a chunked packet is never split across events) |
| `video_status { playbackId, kbps, width, height, copy, rateKbps, rttMs }` | what is being sent, about once a second when it changes |
| `video_ended { playbackId, reason, message? }` | over: `stopped`, or `error` with st-play's reason |

The TUI (`tui/src/videoplayer.ts`, `videoview.ts`) writes `video_output` to its
terminal as it comes and relays every reply for the video's image id back.
Those replies are st-play's acknowledgements, so its flow control measures the
whole path: the daemon socket, the SSH proxy and the client's PTY. The TUI
also reads position and state from them for the status line, and places the
video like any image (`KittyImageData.external`: placed, never transmitted;
its placements report nothing), so it scrolls and crops with history. Stopping
deletes the image in the terminal at once (sound included), then tells the
daemon. A client that disconnects takes its playbacks with it; at most 2 per
client and 8 per daemon.

The daemon uses `$EXOCORTEX_ST_PLAY` or the `st-play` on its PATH (also
`/usr/local/bin`, `/opt/homebrew/bin`), and only one with `--pipe` (st after
Oct 29 2026); otherwise playback ends with "update st".

## Not yet

- The phone app shows the badged poster (it is an ordinary attached image);
  it does not play the video.
- Pasting a video into the prompt: only images paste.

Phone videos with a rotation in their display matrix play upright: ffprobe's
size and the poster are turned, and st-play turns the frames it sends.
