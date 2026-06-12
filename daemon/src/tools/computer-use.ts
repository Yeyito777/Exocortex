/**
 * Computer Use tool contract.
 *
 * This intentionally mirrors Codex's Computer Use MCP surface. The feature flag
 * is on by default while the desktop-control backend is being brought up.
 */

import { readExocortexConfig, type ExocortexConfig } from "@exocortex/shared/config";
import type { Tool, ToolResult, ToolSummary } from "./types";
import {
  executeComputerClick,
  executeComputerCreateTag,
  executeComputerDeleteTag,
  executeComputerDrag,
  executeComputerGetAppState,
  executeComputerHoldClick,
  executeComputerListTags,
  executeComputerListApps,
  executeComputerPerformSecondaryAction,
  executeComputerPressKey,
  executeComputerScroll,
  executeComputerSetValue,
  executeComputerTypeText,
  executeUnsupportedComputerAction,
} from "../computer-use/dwm";

const ACTIONS_NOT_IMPLEMENTED = [
  "Computer Use is partially wired: window observation and coordinate/key/text actions work.",
  "Currently wired: list_apps, get_app_state, click, drag, type_text, press_key, scroll.",
  "Pending: generic accessibility element trees, set_value, and secondary actions.",
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

const COMPUTER_ARG_ORDER = [
  "target",
  "app",
  "include_screenshot",
  "max_elements",
  "monitor",
  "index",
  "position",
  "side",
  "select",
  "force",
  "element_index",
  "x",
  "y",
  "click_count",
  "mouse_button",
  "duration_ms",
  "from_x",
  "from_y",
  "to_x",
  "to_y",
  "text",
  "key",
  "direction",
  "pages",
  "value",
  "action",
];

function shortValue(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = JSON.stringify(value);
  else if (typeof value === "number" || typeof value === "boolean") text = String(value);
  else if (value == null) text = String(value);
  else text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

function summarizeComputerAction(action: string, input: Record<string, unknown>): ToolSummary {
  const keys = [
    ...COMPUTER_ARG_ORDER.filter((key) => Object.prototype.hasOwnProperty.call(input, key)),
    ...Object.keys(input).filter((key) => !COMPUTER_ARG_ORDER.includes(key)).sort(),
  ];
  const args = keys
    .filter((key) => input[key] !== undefined)
    .map((key) => `${key}=${shortValue(input[key])}`)
    .join(" ");
  const detail = args ? `${action} ${args}` : action;
  return { label: "Computer", detail: detail.length > 520 ? `${detail.slice(0, 517)}…` : detail };
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
      color: tool.color ?? "#ff79c6",
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
  summarize: (input) => summarizeComputerAction("list_apps", input),
  execute: (input, _context, signal) => executeComputerListApps(input, signal),
});

export const computerListTags = computerTool({
  name: "computer_list_tags",
  description: "List dwm tags/desktops available for Computer Use, including selected and occupied state.",
  parallelSafety: "safe",
  inputSchema: {
    type: "object",
    properties: {
      target: targetProperty,
    },
  },
  summarize: (input) => summarizeComputerAction("list_tags", input),
  execute: (input, _context, signal) => executeComputerListTags(input, signal),
});

const tagMutationProperties = {
  target: targetProperty,
  monitor: { type: "integer", minimum: 0, description: "dwm monitor number. Defaults to the selected monitor." },
  index: { type: "integer", minimum: 0, description: "Zero-based tag index/position. For create, inserts at this index. For delete, deletes this index." },
  position: { type: "integer", minimum: 0, description: "Alias for index." },
  select: { type: "boolean", description: "Whether to select the created/neighbor tag. Defaults to true." },
};

export const computerCreateTag = computerTool({
  name: "computer_create_tag",
  description: "Create/insert a dwm tag/desktop on a monitor. Returns the updated tag list.",
  inputSchema: {
    type: "object",
    properties: {
      ...tagMutationProperties,
      side: { type: "string", enum: ["left", "right"], description: "When index is omitted, create to the left or right of the selected tag. Defaults to right." },
    },
  },
  summarize: (input) => summarizeComputerAction("create_tag", input),
  execute: (input, _context, signal) => executeComputerCreateTag(input, signal),
});

export const computerDeleteTag = computerTool({
  name: "computer_delete_tag",
  description: "Delete a dwm tag/desktop by zero-based index. Refuses non-empty tags unless force=true. Returns the updated tag list.",
  inputSchema: {
    type: "object",
    properties: {
      ...tagMutationProperties,
      force: { type: "boolean", description: "Delete even if the tag contains windows. Defaults to false." },
    },
  },
  summarize: (input) => summarizeComputerAction("delete_tag", input),
  execute: (input, _context, signal) => executeComputerDeleteTag(input, signal),
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
    "Use computer_list_apps to discover windows and computer_get_app_state to inspect a target window before GUI actions.",
    "Input actions target the requested window and should not move the user's pointer or steal focus.",
    "Treat coordinates as window-relative pixels from the last app state screenshot. element_index support awaits a generic accessibility backend.",
  ].join("\n"),
  summarize: (input) => summarizeComputerAction("get_app_state", input),
  execute: (input, _context, signal) => executeComputerGetAppState(input, signal),
});

export const computerClick = computerTool({
  name: "computer_click",
  description: "Click an app element by element_index from computer_get_app_state or by window-relative coordinates. Returns a refreshed app state.",
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
  summarize: (input) => summarizeComputerAction("click", input),
  execute: (input, _context, signal) => executeComputerClick(input, signal),
});

export const computerHoldClick = computerTool({
  name: "computer_hold_click",
  description: "Press and hold a mouse button at window-relative coordinates for a bounded duration, then release. Returns a refreshed app state.",
  inputSchema: {
    type: "object",
    properties: {
      target: targetProperty,
      app: appProperty,
      x: { type: "number", description: "Window-relative x coordinate to hold at." },
      y: { type: "number", description: "Window-relative y coordinate to hold at." },
      duration_ms: { type: "integer", minimum: 1, maximum: 30000, description: "Hold duration in milliseconds. Defaults to 1000." },
      mouse_button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button. Defaults to left." },
    },
    required: ["app", "x", "y"],
  },
  summarize: (input) => summarizeComputerAction("hold_click", input),
  execute: (input, _context, signal) => executeComputerHoldClick(input, signal),
});

export const computerDrag = computerTool({
  name: "computer_drag",
  description: "Drag within an app from one window-relative point to another. Returns a refreshed app state.",
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
  summarize: (input) => summarizeComputerAction("drag", input),
  execute: (input, _context, signal) => executeComputerDrag(input, signal),
});

export const computerTypeText = computerTool({
  name: "computer_type_text",
  description: "Type literal ASCII text into the target app. Returns a refreshed app state.",
  inputSchema: {
    type: "object",
    properties: {
      target: targetProperty,
      app: appProperty,
      text: { type: "string", description: "Literal text to type." },
    },
    required: ["app", "text"],
  },
  summarize: (input) => summarizeComputerAction("type_text", input),
  execute: (input, _context, signal) => executeComputerTypeText(input, signal),
});

export const computerPressKey = computerTool({
  name: "computer_press_key",
  description: "Press a key or key combination in the target app, such as Enter, Escape, Ctrl+L, Alt+Tab, or Shift+F4. Returns a refreshed app state.",
  inputSchema: {
    type: "object",
    properties: {
      target: targetProperty,
      app: appProperty,
      key: { type: "string", description: "Key or key combination to press." },
    },
    required: ["app", "key"],
  },
  summarize: (input) => summarizeComputerAction("press_key", input),
  execute: (input, _context, signal) => executeComputerPressKey(input, signal),
});

export const computerScroll = computerTool({
  name: "computer_scroll",
  description: "Scroll an app element or window in a direction. Returns a refreshed app state.",
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
  summarize: (input) => summarizeComputerAction("scroll", input),
  execute: (input, _context, signal) => executeComputerScroll(input, signal),
});

export const computerSetValue = computerTool({
  name: "computer_set_value",
  description: "Set the value of an editable/settable accessibility element in an app. Pending generic accessibility backend; app-specific DOM backends are disabled. Returns a refreshed app state.",
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
  summarize: (input) => summarizeComputerAction("set_value", input),
  execute: (input, _context, signal) => executeComputerSetValue(input, signal),
});

export const computerPerformSecondaryAction = computerTool({
  name: "computer_perform_secondary_action",
  description: "Invoke a named secondary accessibility action on an app element. Pending generic accessibility backend; app-specific DOM backends are disabled. Returns a refreshed app state.",
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
  summarize: (input) => summarizeComputerAction("perform_secondary_action", input),
  execute: (input, _context, signal) => executeComputerPerformSecondaryAction(input, signal),
});

export const computerUseTools: Tool[] = [
  computerListApps,
  computerListTags,
  computerCreateTag,
  computerDeleteTag,
  computerGetAppState,
  computerClick,
  computerHoldClick,
  computerDrag,
  computerTypeText,
  computerPressKey,
  computerScroll,
  computerSetValue,
  computerPerformSecondaryAction,
];
