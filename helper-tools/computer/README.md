# Computer helper

`computer` is a local Exocortex helper for inspecting and sending targeted input
to windows managed by the host's patched dwm/Xorg stack. It replaces the former
model-facing `computer_*` API tools, keeping their large schemas and desktop code
out of the daemon.

Invoke the executable by a static relative or absolute path so Exocortex applies
its **Computer** presentation:

```bash
./helper-tools/computer/computer -h
./helper-tools/computer/computer list-apps
./helper-tools/computer/computer state 0x0460000d
./helper-tools/computer/computer click 0x0460000d 420 180
```

State and input commands save screenshots under `/tmp/exocortex-computer/` and
print the exact path. Use Exocortex's `read` tool on that path to inspect it.
Pass `--screenshot PATH` to choose a destination. Literal text is the primary
opaque payload for `type`, so its exact UTF-8 bytes are read from stdin without
trimming (the targeted X11 sender currently accepts ASCII characters):

```bash
./helper-tools/computer/computer type 0x0460000d <<'EOF'
exact text
EOF
```

## Runtime requirements

- Bun
- dwm's local JSONL IPC socket (`DWM_IPC_SOCKET` may override it)
- `maim`, with ImageMagick's `magick import` as screenshot fallback
- `cc` and Xlib development files for input actions
- the `EXOCORTEX-AUTOINPUT` Xorg extension/token for trusted targeted input

The bundled `x11-send.c` helper is compiled on demand beneath
`$XDG_CACHE_HOME/exocortex/computer/` (or `~/.cache/exocortex/computer/`).
Input remains window-targeted: it does not move the user's real pointer or
change the user's actual focused window.
