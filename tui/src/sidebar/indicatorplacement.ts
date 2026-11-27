import { readExocortexConfig } from "@exocortex/shared/config";

/** Where a sidebar row draws its activity and task indicators: before or after its name. */
export type SidebarIndicatorSide = "before" | "after";

export interface SidebarIndicatorPlacement {
  folders: SidebarIndicatorSide;
  conversations: SidebarIndicatorSide;
}

export const DEFAULT_SIDEBAR_INDICATOR_PLACEMENT: SidebarIndicatorPlacement = { folders: "after", conversations: "after" };

let placementSetting: SidebarIndicatorPlacement | null = null;

function side(value: unknown, fallback: SidebarIndicatorSide): SidebarIndicatorSide {
  return value === "before" || value === "after" ? value : fallback;
}

/** config.json `tui.sidebarIndicators`; a missing or unknown value takes the default ("after"). */
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
