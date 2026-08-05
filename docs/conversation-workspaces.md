# Conversation workspaces

Every conversation has a persistent default working directory derived from its
instance and conversation ID:

- main instance: `config/data/workspaces/<conversation-id>/`
- linked worktree instance:
  `config/data/instances/<instance>/workspaces/<conversation-id>/`

New conversations receive their directory when they are created. Existing
conversations are migrated lazily on the first model/tool turn, so daemon startup
does not create a directory for every archived conversation.

The daemon passes the absolute workspace path through the trusted tool execution
context. Bash (including detached commands and external CLIs), read, write, edit,
patch, glob, grep, BTW sessions, and conversation-owned command wakes therefore
resolve relative paths from the owning conversation's workspace. The daemon never
changes its process-wide cwd per turn, so concurrent conversations remain
isolated. `agent.workingDirectory` remains only as a compatibility cwd for
ownerless daemon operations.

Blank drafts that configure custom internal tools reserve the eventual
conversation workspace early. Relative module paths and toolset factory context
use that directory, and successful conversation creation adopts the same
reserved workspace. Only an in-memory daemon reservation permits adoption;
arbitrary client fields cannot attach an orphaned workspace.

Deleting a conversation first commits its soft deletion, then stops its
active/background work and moves its workspace to
`config/data/.../trash/workspaces/<conversation-id>/`. Undo restores the same
directory and its contents. A clone deliberately starts with an empty workspace
instead of silently copying an unbounded directory. An ID remains reserved while
its conversation is recoverable from trash, preventing a later undo from
overwriting an unrelated replacement conversation.

Filesystem and SQLite updates cannot share one transaction, so daemon startup
reconciles crash gaps: any live workspace with no live conversation is moved to
recoverable trash. The inverse restore gap is repaired lazily when the restored
conversation is next used. Undo refuses to attach any colliding live workspace
and preserves the undo entry for a later retry. The legacy JSON backend also
journals multi-file restores so an interrupted operation is completed or rolled
back before conversation state is exposed. Stale live or trashed workspaces from
an interrupted create are preserved under `.orphaned-...` or `.replaced-...`
suffixes before a clean workspace is assigned.

A workspace is a cwd and lifecycle boundary, not a security sandbox. Absolute
paths and symlinks retain the tools' existing safety behavior, and workspace file
contents are not stored in SQLite.
