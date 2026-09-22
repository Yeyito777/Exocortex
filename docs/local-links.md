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
Bare paths retain the existing configured-extension detection; this fallback
does not make arbitrary prose clickable. HTTP(S) links still use `openers.url`.
Other URI schemes, remote file URLs, and control characters are rejected.

## Over `/ssh`

File links use the **selected remote daemon's filesystem**. Relative paths are
resolved in the remote conversation workspace; `~/`, absolute paths, and
`file://` URLs refer to that remote host as well. They never fall back to a
same-named file on the TUI host.

- Regular files are downloaded over SFTP using the selected SSH alias, then
  opened with the TUI host's configured file viewer. These are **local preview
  copies**: editing a preview does not upload changes to the remote file.
- Folders open as `sftp://<ssh-alias>/<remote-path>` via `xdg-open`. The local
  desktop needs an SFTP-capable handler.
- Web links still open locally.
- Both the TUI and remote daemon must support this protocol. Missing files,
  unsupported daemons, or transfer failures report an error rather than opening
  a local substitute. Pending opens are cancelled on disconnect/route changes.

Transfers require OpenSSH `scp` with SFTP support and use the same SSH alias
configuration as `/ssh` (batch authentication, no interactive password prompt).
Files above 128 MiB are rejected at preflight and after transfer; a changing
remote file can exceed that size in transit. Transfers have a two-minute deadline.
Previews live
under the local runtime directory's `file-link-previews/`; previews older than
seven days are removed when another file is fetched.
