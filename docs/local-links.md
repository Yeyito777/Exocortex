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
