# Local Markdown links

History supports clickable local links, including links in tables:

- `[Report](reports/README.md)` — relative to the conversation workspace.
- `[Folder](reports/)` — opens the folder.
- `[Notes](/absolute/path/notes.md)` or `[Notes](~/notes.md)`.
- `[Report](<reports/final report.pdf>)` — angle brackets allow spaces.
- `[Report](file:///tmp/final%20report.pdf)` — local file URLs and
  percent-encoded paths are decoded before opening.

Click a label, or navigate onto it in history with Ctrl+N and press Enter.
Wrapped labels retain the full destination.

Local links use matching `openers.rules` from `config/config.json`.
Files without a matching rule and folders fall back to `xdg-open`.
HTTP(S) links still use `openers.url`.
Other URI schemes, remote file URLs, and control characters are rejected.

## Open editable text in a terminal

Add a rule to `openers.rules`; the **first matching rule wins**:

```json
{
  "text": true,
  "extensions": ["md", "py", "txt"],
  "command": "st",
  "args": ["-e", "nvim", "--", "{path}"]
}
```

`text: true` matches existing regular text files by content, regardless of
extension (for example `.json`, `.rs`, `.gitignore`, and `Makefile`). Detection
samples up to 8 KiB and recognizes UTF-8/ASCII and BOM-marked UTF-16; unreadable
files, directories, and binary samples do not match. Optional `extensions`
also matches those suffixes without requiring an existing file. Neither the
terminal nor editor is hardcoded: both come from the rule. Use absolute
executable paths if they are not on the TUI's PATH; on macOS, for example,
`/Users/you/Applications/st.app/Contents/MacOS/st`.

Put this rule first to edit text even when a later rule handles its extension
(such as HTML or SVG); put it last to preserve those specialized viewers.
Changes to the config are read on each open, without restarting the daemon.

Arguments are passed directly, not through a shell. `{path}` is the decoded,
absolute filesystem path; `{target}` is the original link destination.
Shell commands can use `{path:sh}` or `{target:sh}` for quoted substitutions.

Without a text rule, bare paths are recognized by configured extensions.
With a text rule, qualified bare paths (`/absolute`, `~/home`, `./relative`,
`../relative`, and `file:///…`) are also recognized, including inside code
blocks and across hard-wrapped rows. Content is inspected **only when opening**,
not while navigating history. Use Markdown links for paths with spaces or
unqualified names: `[Build file](Makefile)`.

## Over `/ssh`

File links use the **selected remote daemon's filesystem**. Relative paths are
resolved in the remote conversation workspace; `~/`, absolute paths, and
`file://` URLs refer to that remote host as well. They never fall back to a
same-named file on the TUI host.

- Rules can provide a `remote` command to open the **original remote file**.
  For example, add this to the text rule above:

  ```json
  "remote": {
    "command": "st",
    "args": ["-e", "ssh", "-t", "--", "{host}", "exec nvim -- {path:sh}"]
  }
  ```

  This launches a new terminal, connects to the **currently selected `/ssh`
  alias**, and runs Neovim there. Saving edits updates the remote document,
  not a local copy. `{host}` is that alias; `{path}` is the absolute remote
  path returned by the daemon. `{path:sh}` safely quotes spaces, apostrophes,
  and shell metacharacters for SSH's remote shell. The terminal, SSH program,
  and editor are all configurable. Neovim must be on the remote shell's PATH.
  A matching extension (such as `.md` or `.py`) launches without a download.
  Omit `remote` or set it to `null` to retain preview-only behavior.
- Files without a matching remote opener are downloaded over SFTP and opened
  with the TUI host's configured viewer. These are **local preview copies**:
  editing a preview does not upload changes to the remote file.
  For extensionless/unlisted text files, a temporary download is classified
  first; when the text rule has a remote opener, the preview is discarded and
  Neovim opens the original remote path instead. This works with the existing
  remote daemon protocol, without deploying new code or restarting it.
- Folders open as `sftp://<ssh-alias>/<remote-path>` via `xdg-open`. The local
  desktop needs an SFTP-capable handler.
- Web links still open locally.
- Both the TUI and remote daemon must support this protocol. Missing files,
  unsupported daemons, or transfer failures report an error rather than opening
  a local substitute. Pending opens are cancelled on disconnect/route changes.

Transfers require OpenSSH `scp` with SFTP support and use the same SSH alias
configuration as `/ssh` (batch authentication, no interactive password prompt).
Preview downloads above 128 MiB are rejected at preflight and after transfer; a changing
remote file can exceed that size in transit. Transfers have a two-minute deadline.
Direct remote opens matched by extension do not need a transfer and have no
preview-size limit. If a configured remote terminal cannot launch, an error is
shown; it never silently opens an editable local substitute.
Previews live
under the local runtime directory's `file-link-previews/`; previews older than
seven days are removed when another file is fetched.
