import { readExocortexConfig, updateExocortexConfig } from "@exocortex/shared/config";

/**
 * Where a sidebar row draws its activity and task indicators: before its
 * name, right after it, or at the row's right end.
 */
export type SidebarIndicatorSide = "before" | "after" | "right";

export interface SidebarIndicatorPlacement {
  folders: SidebarIndicatorSide;
  conversations: SidebarIndicatorSide;
}

export const DEFAULT_SIDEBAR_INDICATOR_PLACEMENT: SidebarIndicatorPlacement = { folders: "right", conversations: "right" };

let placementSetting: SidebarIndicatorPlacement | null = null;

function side(value: unknown, fallback: SidebarIndicatorSide): SidebarIndicatorSide {
  return value === "before" || value === "after" || value === "right" ? value : fallback;
}

/** config.json `tui.sidebarIndicators`; a missing or unknown value takes the default ("right"). */
export function resolveSidebarIndicatorPlacement(
  readConfig: () => { tui?: { sidebarIndicators?: unknown } } = readExocortexConfig,
): SidebarIndicatorPlacement {
  try {
    const raw = readConfig().tui?.sidebarIndicators;
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    return {
      folders: side(value.folders, DEFAULT_SIDEBAR_INDICATOR_PLACEMENT.folders),
      conversations: side(value.conversations, DEFAULT_SIDEBAR_INDICATOR_PLACEMENT.conversations),
    };
  } catch {
    return { ...DEFAULT_SIDEBAR_INDICATOR_PLACEMENT };
  }
}

/** Where folder and conversation rows put their indicators (read once per process). */
export function sidebarIndicatorPlacement(): SidebarIndicatorPlacement {
  return placementSetting ??= resolveSidebarIndicatorPlacement();
}

/** Override the setting (tests); null re-reads config.json on next use. */
export function setSidebarIndicatorPlacement(placement: SidebarIndicatorPlacement | null): void {
  placementSetting = placement;
}

const SIDES: readonly SidebarIndicatorSide[] = ["before", "after", "right"];

/**
 * `>` / `<` in the sidebar: move both kinds of row one step right or left
 * through before, after, right, stopping at the ends. Settings that differ
 * step from the conversations' one. Takes effect from the next frame and is
 * saved to config.json `tui.sidebarIndicators`; false when nothing changed.
 */
export function stepSidebarIndicatorPlacement(delta: 1 | -1): boolean {
  const current = sidebarIndicatorPlacement();
  const index = SIDES.indexOf(current.conversations) + delta;
  const side = SIDES[Math.max(0, Math.min(SIDES.length - 1, index))];
  if (current.folders === side && current.conversations === side) return false;
  const next: SidebarIndicatorPlacement = { folders: side, conversations: side };
  placementSetting = next;
  try {
    updateExocortexConfig(config => {
      config.tui = { ...(config.tui ?? {}), sidebarIndicators: { ...next } };
    });
  } catch {
    // An unwritable config keeps the change for this session.
  }
  return true;
}
