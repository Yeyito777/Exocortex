# Helper Tool Standard

Guide for small, user-local tools that need recognizable Exocortex TUI
presentation without becoming full external tools.

## Directory layout

Put local tools under `helper-tools/`. Keep tools with different labels
or colors in separate directories because one manifest applies to every
eligible tool beside it.

```text
helper-tools/
  HELPER_TOOLS_STANDARD.md
  deploy/
    deploy
    exo-manifest.json
```

Local entries in this directory are ignored by Git. The standard and any
explicitly bundled helpers unignored by the repository remain tracked.

## Tool

A helper tool is an ordinary executable. Give it a shebang, make it
executable, and provide concise `-h` output.

```bash
#!/usr/bin/env bash
set -euo pipefail

environment="${1:?usage: deploy <environment>}"
printf 'Deployed to %s.\n' "$environment"
```

```bash
chmod +x ./helper-tools/deploy/deploy
./helper-tools/deploy/deploy production
```

Invoke the tool through a static relative or absolute path. PATH-only names,
interpreter arguments such as `bash deploy`, shell expansion, and command
substitution do not receive custom presentation.

Helper tools are not discovered or added to the model's instructions. Tell
the model when to use one in `AGENTS.md`, project documentation, or the request.

## Display manifest

Place `exo-manifest.json` beside the executable:

```json
{
  "version": 1,
  "display": {
    "label": "Deploy",
    "color": "#7aa2f7"
  }
}
```

- `version` must be `1`.
- `display.label` must be non-empty and at most 64 characters.
- `display.color` must be a six-digit hex color.
- The manifest changes presentation only. It cannot affect execution, arguments,
  environment, permissions, output, auth, or daemon supervision.
- Missing or invalid manifests fall back to ordinary Bash presentation.

## Payloads

Put structural values such as IDs, flags, names, and paths in argv. If the tool
accepts one primary opaque payload such as a message, body, prompt, or JavaScript,
read its exact UTF-8 bytes from stdin instead of accepting it inline.
Do not trim, decode, interpolate, or otherwise rewrite it.

## When to use an external tool

Use a full [external tool](../external-tools/TOOL_STANDARD.md) when the tool
needs global discovery, system-prompt instructions, PATH installation, complicated auth (JWST),
notifications, or daemon supervision.
