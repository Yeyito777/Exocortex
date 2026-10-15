import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import { saveSidebarFolderViewPreference, setSidebarFolderView } from "../sidebar/folderview";
import type { SidebarFolderView } from "../sidebar/tree";
import type { SlashCommand } from "./types";

const USAGE = "Usage: /folders [tree|navigate]";

const DESCRIPTIONS: Record<SidebarFolderView, string> = {
  tree: "folders expand in place; Ctrl+P files new conversations in the cursor's folder, Ctrl+Shift+O at the top level",
  navigate: "opening a folder shows only its contents",
};

export const FOLDERS_COMMAND: SlashCommand = {
  name: "/folders",
  description: "Set how sidebar folders open (saved locally)",
  args: [
    { name: "tree", desc: "Expand folders in place" },
    { name: "navigate", desc: "Open folders as their own list" },
  ],
  handler: (text, state) => {
    const parts = text.trim().split(/\s+/);
    const arg = parts[1]?.toLowerCase();
    if (parts.length > 2 || (arg !== undefined && arg !== "tree" && arg !== "navigate")) {
      pushSystemMessage(state, USAGE);
      clearPrompt(state);
      return { type: "handled" };
    }

    if (arg === undefined) {
      const view = state.sidebar.folderView;
      pushSystemMessage(state, `Folders: ${view} (${DESCRIPTIONS[view]}).\n\n${USAGE}`);
      clearPrompt(state);
      return { type: "handled" };
    }

    saveSidebarFolderViewPreference(arg);
    setSidebarFolderView(state.sidebar, arg);
    pushSystemMessage(state, `Folders: ${arg} (${DESCRIPTIONS[arg]}).`);
    clearPrompt(state);
    return { type: "handled" };
  },
};
