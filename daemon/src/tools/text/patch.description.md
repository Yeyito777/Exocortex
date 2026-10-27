Use the patch tool to edit files with a Codex-style apply_patch format. The input is the entire patch text.

Patch envelope:
*** Begin Patch
[one or more file sections]
*** End Patch

File sections:
*** Add File: <relative path>      create/write a file; following lines must start with +
*** Delete File: <relative path>   delete a file
*** Update File: <relative path>   update a file in place; may be followed by *** Move to: <relative path>

Update hunks start with @@ optionally followed by a context line, then lines prefixed with space (context), - (old), or + (new). Use about 3 lines of context around each change. File references must be relative, never absolute.
