import { describe, expect, test } from "bun:test";

import {
  createConversationActionMenu,
  handleConversationActionMenuKey,
  renderConversationActionMenu,
} from "./conversationactions";
import { theme } from "../theme";

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[\d+;\d+H/g, "\n")
    .replace(/\x1b\[[0-9;]*m/g, "");
}

describe("conversation action menu", () => {
  test("navigates with j/k and closes with escape", () => {
    const menu = createConversationActionMenu("conv-1", false, false);

    expect(menu.selection).toBe("copy_id");
    handleConversationActionMenuKey(menu, { type: "char", char: "k" });
    expect(menu.selection).toBe("copy_id");
    handleConversationActionMenuKey(menu, { type: "char", char: "j" });
    expect(menu.selection).toBe("toggle_star");
    handleConversationActionMenuKey(menu, { type: "down" });
    expect(menu.selection).toBe("toggle_pin");
    handleConversationActionMenuKey(menu, { type: "char", char: "j" });
    expect(menu.selection).toBe("delete");
    handleConversationActionMenuKey(menu, { type: "up" });
    expect(menu.selection).toBe("toggle_pin");
    expect(handleConversationActionMenuKey(menu, { type: "escape" })).toEqual({ type: "close" });
  });

  test("emits ordinary actions immediately and confirms delete", () => {
    const menu = createConversationActionMenu("conv-1", false, false);
    expect(handleConversationActionMenuKey(menu, { type: "enter" })).toEqual({
      type: "action",
      action: "copy_id",
    });

    menu.selection = "delete";
    expect(handleConversationActionMenuKey(menu, { type: "enter" })).toEqual({ type: "handled" });
    expect(menu.deleteConfirmation).toBe(true);
    expect(handleConversationActionMenuKey(menu, { type: "enter" })).toEqual({
      type: "action",
      action: "delete",
    });
  });

  test("renders beside the sidebar with all options and destructive text in red", () => {
    const menu = createConversationActionMenu("conv-1", false, false);
    const rendered = renderConversationActionMenu(menu, 3, 29, 20, 80);
    const plain = stripAnsi(rendered);

    expect(plain).toContain("Copy id");
    expect(plain).toContain("Star");
    expect(plain).toContain("Pin");
    expect(plain).toContain("Delete");
    expect(rendered).toContain(theme.error);
    expect(rendered).toContain("\x1b[3;29H");
  });

  test("shows inverse labels for an already starred and pinned conversation", () => {
    const menu = createConversationActionMenu("conv-1", true, true);
    const rendered = stripAnsi(renderConversationActionMenu(menu, 3, 29, 20, 80));

    expect(rendered).toContain("Unstar");
    expect(rendered).toContain("Unpin");
  });
});
