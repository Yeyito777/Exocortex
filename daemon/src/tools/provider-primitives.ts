import type { ProviderId } from "../messages";

export const CODEX_PRIMITIVES = ["exec_command", "write_stdin", "apply_patch", "view_image"] as const;
const legacy = new Set(["bash", "read", "write", "edit", "patch", "glob", "grep"]);
const codex = new Set<string>(CODEX_PRIMITIVES);

/** Translate tool authority, never grant a shell just because a reader is enabled. */
export function providerToolNames(names: readonly string[], provider?: ProviderId): string[] {
  const selected = new Set(names.filter(name => name !== "goal"));
  if (provider === "openai") {
    if (selected.has("bash")) {
      selected.add("exec_command");
      selected.add("write_stdin");
    }
    if (selected.has("patch")) selected.add("apply_patch");
    if (selected.has("read")) selected.add("view_image");
    return [...selected].filter(name => !legacy.has(name));
  }
  if (selected.has("exec_command")) selected.add("bash");
  if (selected.has("apply_patch")) selected.add("patch");
  if (selected.has("view_image")) selected.add("read");
  return [...selected].filter(name => !codex.has(name));
}

// Canonical OpenAI freeform grammar. This tool is represented internally as
// {input: rawText}; only the provider boundary changes its wire representation.
export const APPLY_PATCH_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?
hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?
filename: /(.+)/
add_line: "+" /(.*)/ LF -> line
change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF
%import common.LF`;
