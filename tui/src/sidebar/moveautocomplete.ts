import { movePromptMatches } from "./folders";
import type { SidebarState } from "./state";

export function updateMovePromptAutocomplete(sidebar: SidebarState): void {
  const prompt = sidebar.prompt;
  if (!prompt || prompt.purpose !== "move_items") return;
  const matches = movePromptMatches({
    conversations: sidebar.conversations,
    folders: sidebar.folders,
    currentFolderId: sidebar.currentFolderId,
    items: prompt.items,
    input: prompt.input,
  });
  prompt.autocomplete = matches.length > 0
    ? { selection: -1, prefix: prompt.input, matches }
    : null;
}

export function cycleMovePromptAutocomplete(sidebar: SidebarState, direction: 1 | -1): boolean {
  const prompt = sidebar.prompt;
  if (!prompt || prompt.purpose !== "move_items") return false;
  if (!prompt.autocomplete || prompt.autocomplete.matches.length === 0) updateMovePromptAutocomplete(sidebar);
  const autocomplete = prompt.autocomplete;
  if (!autocomplete || autocomplete.matches.length === 0) return false;

  autocomplete.selection = direction === 1
    ? (autocomplete.selection < 0 ? 0 : (autocomplete.selection + 1) % autocomplete.matches.length)
    : (autocomplete.selection <= 0 ? autocomplete.matches.length - 1 : autocomplete.selection - 1);
  const name = autocomplete.matches[autocomplete.selection]?.name;
  if (!name) return false;
  prompt.input = name;
  prompt.cursorPos = name.length;
  return true;
}
