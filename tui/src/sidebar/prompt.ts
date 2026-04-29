import type { CompletionItem } from "../commands";
import { theme } from "../theme";
import { getViewportByWidth, padRightToWidth, termWidth } from "../textwidth";

export type SidebarPromptPurpose = "create_folder" | "move_items" | "rename_folder";

export interface SidebarPromptAutocompleteState {
  /** Index into matches: -1 = no selection yet, 0+ = selected item. */
  selection: number;
  /** User text that produced the current match set; kept stable while Tab-cycling. */
  prefix: string;
  matches: CompletionItem[];
}

export interface SidebarPromptState {
  purpose: SidebarPromptPurpose;
  input: string;
  cursorPos: number;
  items: import("../messages").SidebarItemRef[];
  folderId?: string;
  autocomplete?: SidebarPromptAutocompleteState | null;
}

export function getSidebarPromptBar(prompt: SidebarPromptState, width: number): string {
  const label = prompt.purpose === "create_folder"
    ? "Folder"
    : prompt.purpose === "move_items"
      ? "Move"
      : "Rename";
  const prefix = `${label}: `;
  const maxWidth = Math.max(0, width - termWidth(prefix));
  const viewport = getViewportByWidth(prompt.input, prompt.cursorPos, maxWidth);
  const displayText = viewport.visibleText
    ? padRightToWidth(viewport.visibleText, maxWidth)
    : padRightToWidth(prompt.purpose === "move_items" ? "folder" : "name", maxWidth);
  const textStyle = viewport.visibleText ? theme.text : theme.dim;
  // Match sidebar /? search styling: the prompt label is accent-colored, but
  // placeholder text starts from normal text fg before applying dim. Otherwise
  // dim-only themes inherit the accent foreground and show a dim accent.
  return theme.sidebarBg + theme.accent + prefix + theme.text + textStyle + displayText;
}

export function sidebarPromptAutocompleteVisibleRows(
  prompt: SidebarPromptState | null,
  searchBarOpen: boolean,
  totalRows: number,
): number {
  const autocomplete = prompt?.autocomplete;
  if (!prompt || searchBarOpen || !autocomplete?.matches.length) return 0;
  // Keep at least a small amount of the list visible; unlike promptline's chat
  // overlay, the sidebar popup consumes rows in the sidebar column.
  const maxVisible = Math.max(0, Math.min(5, totalRows - 5));
  return Math.min(autocomplete.matches.length, maxVisible);
}

export function getSidebarPromptAutocompleteRows(
  prompt: SidebarPromptState,
  width: number,
  visibleRows: number,
): string[] {
  const autocomplete = prompt.autocomplete;
  if (!autocomplete || autocomplete.matches.length === 0 || visibleRows <= 0) return [];

  const { matches, selection } = autocomplete;
  const maxName = matches.reduce((max, item) => Math.max(max, termWidth(item.name)), 0);
  const markerWidth = 2;
  const nameWidth = Math.min(maxName + 1, Math.max(0, Math.floor((width - markerWidth) * 0.6)));
  const descWidth = Math.max(0, width - markerWidth - nameWidth);
  const total = matches.length;
  const winSize = Math.min(total, visibleRows);
  let winStart = 0;

  if (total > winSize && selection >= 0) {
    const ideal = selection - Math.floor(winSize / 2);
    winStart = Math.max(0, Math.min(ideal, total - winSize));
  }

  const rows: string[] = [];
  for (let vi = 0; vi < winSize; vi++) {
    const i = winStart + vi;
    const item = matches[i];
    const isSelected = selection === i;
    const bg = isSelected ? theme.sidebarSelBg : theme.sidebarBg;
    const marker = isSelected ? "▸ " : "  ";
    const upIndicator = vi === 0 && winStart > 0;
    const downIndicator = vi === winSize - 1 && winStart + winSize < total;
    const indicator = upIndicator ? "▲" : downIndicator ? "▼" : "";
    const descBodyWidth = Math.max(0, descWidth - termWidth(indicator));
    const name = padRightToWidth(item.name, nameWidth);
    const desc = padRightToWidth(item.desc, descBodyWidth) + indicator;
    rows.push(bg + theme.accent + marker + theme.text + name + theme.dim + desc + theme.reset);
  }
  return rows;
}
