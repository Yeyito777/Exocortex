/**
 * Computer Use tool contract.
 *
 * This intentionally mirrors Codex's Computer Use MCP surface. The feature flag
 * is on by default while the dwm/X11/AT-SPI backend is being brought up.
 */

import { readExocortexConfig, type ExocortexConfig } from "@exocortex/shared/config";
import type { Tool, ToolResult, ToolSummary } from "./types";
import {
  executeComputerClick,
  executeComputerDrag,
  executeComputerGetAppState,
  executeComputerListApps,
  executeComputerPerformSecondaryAction,
  executeComputerPressKey,
  executeComputerScroll,
  executeComputerSetValue,
  executeComputerTypeText,
  executeUnsupportedComputerAction,
} from "../computer-use/dwm";

const ACTIONS_NOT_IMPLEMENTED = [
  "Computer Use is partially wired: dwm IPC observation and targeted background input work for coordinate/key/text actions.",
  "Currently wired: list_apps, get_app_state, click, drag, type_text, press_key, scroll. A patched Xorg EXOCORTEX-AUTOINPUT extension is preferred when present; plain X11 fallback is used otherwise.",
  "Pending: generic AT-SPI set_value/secondary accessibility actions and element trees.",
].join("\n");

export function isComputerUseFeatureEnabled(config: ExocortexConfig = readExocortexConfig()): boolean {
  // Feature flag is intentionally default-on during bring-up. Set
  // config.features.computerUse=false to hide all Computer Use tools.
  return config.features?.computerUse !== false;
}

function executeActionNotImplemented(input: Record<string, unknown>): Promise<ToolResult> {
  if (typeof input.app === "string" && input.app.trim()) return executeUnsupportedComputerAction(input);
  return Promise.resolve({ output: ACTIONS_NOT_IMPLEMENTED, isError: true });
}

function summarizeWithApp(label: string, input: Record<string, unknown>): ToolSummary {
  const app = typeof input.app === "string" && input.app.trim() ? input.app.trim() : "app";
  return { label, detail: app };
}

const appProperty = {
  type: "string",
  description: "App name, window title, process id, window id, class, or bundle-like identifier to target.",
};

const targetProperty = {
  type: "string",
  description: "Execution target. Defaults to host. Future values may include host or xenv:<name>.",
};

const elementIndexProperty = {
  type: "string",
  description: "Element index from the most recent computer_get_app_state tree for this app.",
};

function computerTool(tool: Omit<Tool, "isAvailable" | "parallelSafety" | "display" | "execute"> & {
  color?: string;
  execute?: Tool["execute"];
  parallelSafety?: Tool["parallelSafety"];
}): Tool {
  return {
    ...tool,
    parallelSafety: tool.parallelSafety ?? "exclusive",
    isAvailable: isComputerUseFeatureEnabled,
    display: {
      label: "Computer",
      color: tool.color ?? "#ffb86c",
    },
    execute: tool.execute ?? executeActionNotImplemented,
  };
}

export const computerListApps = computerTool({
  name: "computer_list_apps",
  description: "List apps/windows available for Computer Use, including running apps and recently used/window-managed apps.",
  parallelSafety: "safe",
  inputSchema: {
    type: "object",
    properties: {
      target: targetProperty,
    },
  },
  summarize: () => ({ label: "Computer", detail: "list apps" }),
  execute: (input, _context, signal) => executeComputerListApps(input, signal),
});

export const computerGetAppState = computerTool({
  name: "computer_get_app_state",
  description: "Return an app/window state snapshot for Computer Use: focused window metadata, accessibility tree when available, and a screenshot. Call this before Computer Use actions.",
  parallelSafety: "exclusive",
  inputSchema: {
    type: "object",
    properties: {
      target: targetProperty,
      app: appProperty,
      include_screenshot: {
        type: "boolean",
        description: "Whether to include a screenshot image in the result. Defaults to true.",
      },
      max_elements: {
        type: "integer",
        minimum: 1,
        maximum: 2000,
        description: "Maximum accessibility elements to include in the rendered app_state tree.",
      },
    },
    required: ["app"],
  },
  systemHint: [
    "Computer Use tools are available behind a bring-up feature flag. The dwm IPC observation backend and targeted background coordinate/key/text actions are wired.",
    "Use computer_list_apps to discover window ids/classes/titles and computer_get_app_state to inspect a target window before GUI actions.",
    "Input actions prefer the patched Xorg EXOCORTEX-AUTOINPUT trusted targeted-event path when available, otherwise fall back to plain X11 events. They should not switch dwm tags, steal focus, or depend on app-specific backends.",
    "Treat coordinates as window-relative pixels from the last app state screenshot. element_index support awaits a generic AT-SPI backend.",
  ].join("\n"),
  summarize: (input) => summarizeWithApp("Computer state", input),
  execute: (input, _context, signal) => executeComputerGetAppState(input, signal),
});

export const computerClick = computerTool({
  name: "computer_click",
  description: "Click an app element by element_index from computer_get_app_state or by window-relative coordinates. Coordinate clicks use direct background X11 events and return a refreshed app state.",
  inputSchema: {
    type: "object",
    properties: {
      target: targetProperty,
      app: appProperty,
      element_index: elementIndexProperty,
      x: { type: "number", description: "Window-relative x coordinate to click." },
      y: { type: "number", description: "Window-relative y coordinate to click." },
      click_count: { type: "integer", minimum: 1, maximum: 3, description: "Number of clicks. Defaults to 1." },
      mouse_button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button. Defaults to left." },
    },
    required: ["app"],
  },
  summarize: (input) => summarizeWithApp("Computer click", input),
  execute: (input, _context, signal) => executeComputerClick(input, signal),
});

export const computerDrag = computerTool({
  name: "computer_drag",
  description: "Drag within an app from one window-relative point to another using direct background X11 events. Returns a refreshed app state.",
  inputSchema: {
    type: "object",
    properties: {
      target: targetProperty,
      app: appProperty,
      from_x: { type: "number", description: "Window-relative drag start x coordinate." },
      from_y: { type: "number", description: "Window-relative drag start y coordinate." },
      to_x: { type: "number", description: "Window-relative drag end x coordinate." },
      to_y: { type: "number", description: "Window-relative drag end y coordinate." },
    },
    required: ["app", "from_x", "from_y", "to_x", "to_y"],
  },
  summarize: (input) => summarizeWithApp("Computer drag", input),
  execute: (input, _context, signal) => executeComputerDrag(input, signal),
});

export const computerTypeText = computerTool({
  name: "computer_type_text",
  description: "Type literal ASCII text into the target app using direct background X11 events. Returns a refreshed app state.",
  inputSchema: {
    type: "object",
    properties: {
      target: targetProperty,
      app: appProperty,
      text: { type: "string", description: "Literal text to type." },
    },
    required: ["app", "text"],
  },
  summarize: (input) => summarizeWithApp("Computer type", input),
  execute: (input, _context, signal) => executeComputerTypeText(input, signal),
});

export const computerPressKey = computerTool({
  name: "computer_press_key",
  description: "Press a key or key combination in the target app using direct background X11 events, such as Enter, Escape, Ctrl+L, Alt+Tab, or Shift+F4. Returns a refreshed app state.",
  inputSchema: {
    type: "object",
    properties: {
      target: targetProperty,
      app: appProperty,
      key: { type: "string", description: "Key or key combination to press." },
    },
    required: ["app", "key"],
  },
  summarize: (input) => summarizeWithApp("Computer key", input),
  execute: (input, _context, signal) => executeComputerPressKey(input, signal),
});

export const computerScroll = computerTool({
  name: "computer_scroll",
  description: "Scroll an app element or window in a direction using direct background X11 events. Returns a refreshed app state.",
  inputSchema: {
    type: "object",
    properties: {
      target: targetProperty,
      app: appProperty,
      element_index: elementIndexProperty,
      direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Scroll direction." },
      pages: { type: "integer", minimum: 1, maximum: 20, description: "Number of wheel/page units to scroll. Defaults to 1." },
    },
    required: ["app", "direction"],
  },
  summarize: (input) => summarizeWithApp("Computer scroll", input),
  execute: (input, _context, signal) => executeComputerScroll(input, signal),
});

export const computerSetValue = computerTool({
  name: "computer_set_value",
  description: "Set the value of an editable/settable accessibility element in an app. Pending generic AT-SPI backend; app-specific DOM backends are disabled. Returns a refreshed app state.",
  inputSchema: {
    type: "object",
    properties: {
      target: targetProperty,
      app: appProperty,
      element_index: elementIndexProperty,
      value: { type: "string", description: "Value to set on the target element." },
    },
    required: ["app", "element_index", "value"],
  },
  summarize: (input) => summarizeWithApp("Computer set value", input),
  execute: (input, _context, signal) => executeComputerSetValue(input, signal),
});

export const computerPerformSecondaryAction = computerTool({
  name: "computer_perform_secondary_action",
  description: "Invoke a named secondary accessibility action on an app element. Pending generic AT-SPI backend; app-specific DOM backends are disabled. Returns a refreshed app state.",
  inputSchema: {
    type: "object",
    properties: {
      target: targetProperty,
      app: appProperty,
      element_index: elementIndexProperty,
      action: { type: "string", description: "Accessibility action name to invoke, such as press, open, raise, or show menu." },
    },
    required: ["app", "element_index", "action"],
  },
  summarize: (input) => summarizeWithApp("Computer action", input),
  execute: (input, _context, signal) => executeComputerPerformSecondaryAction(input, signal),
});

export const computerUseTools: Tool[] = [
  computerListApps,
  computerGetAppState,
  computerClick,
  computerDrag,
  computerTypeText,
  computerPressKey,
  computerScroll,
  computerSetValue,
  computerPerformSecondaryAction,
];
