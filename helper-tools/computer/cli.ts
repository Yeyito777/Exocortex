#!/usr/bin/env bun

import { mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, extname, join, resolve } from "path";
import { randomUUID } from "crypto";
import {
  executeComputerClick,
  executeComputerCreateTag,
  executeComputerDeleteTag,
  executeComputerDrag,
  executeComputerGetAppState,
  executeComputerHoldClick,
  executeComputerListApps,
  executeComputerListTags,
  executeComputerMoveRelative,
  executeComputerPressKey,
  executeComputerScroll,
  executeComputerTypeText,
  type ComputerResult,
} from "./core";

const HELP = `Usage: computer <command> [arguments] [options]

Inspect and control host dwm windows without moving the real pointer or changing
real focus. Coordinates are window-relative pixels from the latest screenshot.

Observation:
  list-apps
  list-tags
  state APP [--no-screenshot] [--screenshot PATH]

Window input (each returns refreshed state and a screenshot):
  click APP X Y [--button left|right|middle] [--count 1..3]
  hold-click APP X Y [--button BUTTON] [--duration-ms 1..30000]
  move-relative APP DX DY [--steps 1..200]
  drag APP FROM_X FROM_Y TO_X TO_Y
  type APP                    Read exact UTF-8 stdin (ASCII input today)
  key APP KEY                 Examples: Enter, Escape, Ctrl+L, Shift+F4
  scroll APP up|down|left|right [--pages 1..20]

Workspace input:
  create-tag [--monitor N] [--index N|--position N|--side left|right]
             [--select|--no-select]  (defaults to --no-select)
  delete-tag [--monitor N] [--index N|--position N] [--force]
             [--select|--no-select]  (defaults to --no-select)

Common options:
  --screenshot PATH           Save the returned screenshot at PATH
  -h, --help                  Show this help

APP may be a window title, class, PID, X11 window ID, or focused. Use list-apps
first. Screenshots default to a unique path under the system temporary directory.
The helper requires dwm JSONL IPC; input additionally requires cc and Xlib.
`;

const VALUE_OPTIONS = new Set([
  "button",
  "count",
  "duration-ms",
  "index",
  "monitor",
  "pages",
  "position",
  "screenshot",
  "side",
  "steps",
]);
const FLAG_OPTIONS = new Set(["force", "help", "no-screenshot", "no-select", "select"]);

interface ParsedArgs {
  positionals: string[];
  options: Map<string, string | boolean>;
}

class UsageError extends Error {}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options = new Map<string, string | boolean>();
  let positionalOnly = false;

  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i]!;
    if (positionalOnly) {
      positionals.push(argument);
      continue;
    }
    if (argument === "--") {
      positionalOnly = true;
      continue;
    }
    if (argument === "-h") {
      options.set("help", true);
      continue;
    }
    if (!argument.startsWith("--") || /^-\d/.test(argument)) {
      positionals.push(argument);
      continue;
    }

    const equals = argument.indexOf("=");
    const name = argument.slice(2, equals < 0 ? undefined : equals);
    if (!name) throw new UsageError(`invalid option: ${argument}`);
    if (options.has(name)) throw new UsageError(`option supplied more than once: --${name}`);

    if (equals >= 0) {
      if (FLAG_OPTIONS.has(name) && !VALUE_OPTIONS.has(name)) {
        throw new UsageError(`--${name} does not take a value`);
      }
      options.set(name, argument.slice(equals + 1));
      continue;
    }
    if (FLAG_OPTIONS.has(name)) {
      options.set(name, true);
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new UsageError(`unknown option: --${name}`);
    const value = argv[++i];
    if (value === undefined) throw new UsageError(`--${name} requires a value`);
    options.set(name, value);
  }

  return { positionals, options };
}

function assertAllowedOptions(parsed: ParsedArgs, allowed: readonly string[]): void {
  const allowedSet = new Set([...allowed, "help"]);
  for (const name of parsed.options.keys()) {
    if (!allowedSet.has(name)) throw new UsageError(`option --${name} is not valid for this command`);
  }
}

function expectPositionals(parsed: ParsedArgs, command: string, count: number): string[] {
  if (parsed.positionals.length !== count) {
    throw new UsageError(`${command} expects ${count} argument${count === 1 ? "" : "s"}; received ${parsed.positionals.length}`);
  }
  return parsed.positionals;
}

function numberValue(value: string, label: string, options: { integer?: boolean; min?: number; max?: number } = {}): number {
  if (value.trim() === "" || !Number.isFinite(Number(value))) throw new UsageError(`${label} must be a number`);
  const number = Number(value);
  if (options.integer && !Number.isInteger(number)) throw new UsageError(`${label} must be an integer`);
  if (options.min != null && number < options.min) throw new UsageError(`${label} must be at least ${options.min}`);
  if (options.max != null && number > options.max) throw new UsageError(`${label} must be at most ${options.max}`);
  return number;
}

function optionNumber(
  parsed: ParsedArgs,
  name: string,
  options: { integer?: boolean; min?: number; max?: number } = {},
): number | undefined {
  const value = parsed.options.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new UsageError(`--${name} requires a value`);
  return numberValue(value, `--${name}`, options);
}

function optionString(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.options.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new UsageError(`--${name} requires a value`);
  return value;
}

function selectionOption(parsed: ParsedArgs): boolean | undefined {
  const select = parsed.options.has("select");
  const noSelect = parsed.options.has("no-select");
  if (select && noSelect) throw new UsageError("--select and --no-select are mutually exclusive");
  if (select) return true;
  if (noSelect) return false;
  return undefined;
}

function screenshotOptions(parsed: ParsedArgs): { includeScreenshot: boolean; path?: string } {
  const path = optionString(parsed, "screenshot");
  const disabled = parsed.options.has("no-screenshot");
  if (path && disabled) throw new UsageError("--screenshot and --no-screenshot are mutually exclusive");
  return { includeScreenshot: !disabled, path: path ? resolve(path) : undefined };
}

function inputWithoutUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function commonActionInput(parsed: ParsedArgs, app: string): Record<string, unknown> {
  const screenshot = screenshotOptions(parsed);
  return inputWithoutUndefined({ app, include_screenshot: screenshot.includeScreenshot });
}

async function dispatch(command: string, parsed: ParsedArgs, signal: AbortSignal): Promise<ComputerResult> {
  if (parsed.options.has("help")) return { output: HELP.trimEnd(), isError: false };

  switch (command) {
    case "list-apps": {
      assertAllowedOptions(parsed, []);
      expectPositionals(parsed, command, 0);
      return executeComputerListApps({}, signal);
    }
    case "list-tags": {
      assertAllowedOptions(parsed, []);
      expectPositionals(parsed, command, 0);
      return executeComputerListTags({}, signal);
    }
    case "create-tag": {
      assertAllowedOptions(parsed, ["monitor", "index", "position", "side", "select", "no-select"]);
      expectPositionals(parsed, command, 0);
      const placements = ["index", "position", "side"].filter((name) => parsed.options.has(name));
      if (placements.length > 1) throw new UsageError("--index, --position, and --side are mutually exclusive");
      const side = optionString(parsed, "side");
      if (side && side !== "left" && side !== "right") throw new UsageError("--side must be left or right");
      return executeComputerCreateTag(inputWithoutUndefined({
        monitor: optionNumber(parsed, "monitor", { integer: true, min: 0 }),
        index: optionNumber(parsed, "index", { integer: true, min: 0 }),
        position: optionNumber(parsed, "position", { integer: true, min: 0 }),
        side,
        select: selectionOption(parsed) ?? false,
      }), signal);
    }
    case "delete-tag": {
      assertAllowedOptions(parsed, ["monitor", "index", "position", "force", "select", "no-select"]);
      expectPositionals(parsed, command, 0);
      if (parsed.options.has("index") && parsed.options.has("position")) {
        throw new UsageError("--index and --position are mutually exclusive");
      }
      return executeComputerDeleteTag(inputWithoutUndefined({
        monitor: optionNumber(parsed, "monitor", { integer: true, min: 0 }),
        index: optionNumber(parsed, "index", { integer: true, min: 0 }),
        position: optionNumber(parsed, "position", { integer: true, min: 0 }),
        force: parsed.options.has("force") || undefined,
        select: selectionOption(parsed) ?? false,
      }), signal);
    }
    case "state": {
      assertAllowedOptions(parsed, ["no-screenshot", "screenshot"]);
      const [app] = expectPositionals(parsed, command, 1);
      const screenshot = screenshotOptions(parsed);
      return executeComputerGetAppState({ app, include_screenshot: screenshot.includeScreenshot }, signal);
    }
    case "click": {
      assertAllowedOptions(parsed, ["button", "count", "screenshot"]);
      const [app, x, y] = expectPositionals(parsed, command, 3);
      const button = optionString(parsed, "button") ?? "left";
      if (!["left", "right", "middle"].includes(button)) throw new UsageError("--button must be left, right, or middle");
      return executeComputerClick(inputWithoutUndefined({
        ...commonActionInput(parsed, app!),
        x: numberValue(x!, "X"),
        y: numberValue(y!, "Y"),
        mouse_button: button,
        click_count: optionNumber(parsed, "count", { integer: true, min: 1, max: 3 }),
      }), signal);
    }
    case "hold-click": {
      assertAllowedOptions(parsed, ["button", "duration-ms", "screenshot"]);
      const [app, x, y] = expectPositionals(parsed, command, 3);
      const button = optionString(parsed, "button") ?? "left";
      if (!["left", "right", "middle"].includes(button)) throw new UsageError("--button must be left, right, or middle");
      return executeComputerHoldClick(inputWithoutUndefined({
        ...commonActionInput(parsed, app!),
        x: numberValue(x!, "X"),
        y: numberValue(y!, "Y"),
        mouse_button: button,
        duration_ms: optionNumber(parsed, "duration-ms", { integer: true, min: 1, max: 30_000 }),
      }), signal);
    }
    case "move-relative": {
      assertAllowedOptions(parsed, ["steps", "screenshot"]);
      const [app, dx, dy] = expectPositionals(parsed, command, 3);
      return executeComputerMoveRelative(inputWithoutUndefined({
        ...commonActionInput(parsed, app!),
        dx: numberValue(dx!, "DX", { integer: true }),
        dy: numberValue(dy!, "DY", { integer: true }),
        steps: optionNumber(parsed, "steps", { integer: true, min: 1, max: 200 }),
      }), signal);
    }
    case "drag": {
      assertAllowedOptions(parsed, ["screenshot"]);
      const [app, fromX, fromY, toX, toY] = expectPositionals(parsed, command, 5);
      return executeComputerDrag({
        ...commonActionInput(parsed, app!),
        from_x: numberValue(fromX!, "FROM_X"),
        from_y: numberValue(fromY!, "FROM_Y"),
        to_x: numberValue(toX!, "TO_X"),
        to_y: numberValue(toY!, "TO_Y"),
      }, signal);
    }
    case "type": {
      assertAllowedOptions(parsed, ["screenshot"]);
      const [app] = expectPositionals(parsed, command, 1);
      const text = await Bun.stdin.text();
      return executeComputerTypeText({ ...commonActionInput(parsed, app!), text }, signal);
    }
    case "key": {
      assertAllowedOptions(parsed, ["screenshot"]);
      const [app, key] = expectPositionals(parsed, command, 2);
      return executeComputerPressKey({ ...commonActionInput(parsed, app!), key }, signal);
    }
    case "scroll": {
      assertAllowedOptions(parsed, ["pages", "screenshot"]);
      const [app, direction] = expectPositionals(parsed, command, 2);
      if (!["up", "down", "left", "right"].includes(direction!)) {
        throw new UsageError("scroll direction must be up, down, left, or right");
      }
      return executeComputerScroll(inputWithoutUndefined({
        ...commonActionInput(parsed, app!),
        direction,
        pages: optionNumber(parsed, "pages", { integer: true, min: 1, max: 20 }),
      }), signal);
    }
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

function imageExtension(mediaType: string): string {
  if (mediaType === "image/jpeg") return ".jpg";
  if (mediaType === "image/webp") return ".webp";
  return ".png";
}

async function saveScreenshot(image: NonNullable<ComputerResult["image"]>, requestedPath?: string): Promise<string> {
  const extension = imageExtension(image.mediaType);
  const path = requestedPath
    ? (extname(requestedPath) ? requestedPath : requestedPath + extension)
    : join(tmpdir(), "exocortex-computer", `${Date.now()}-${randomUUID().slice(0, 8)}${extension}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(image.base64, "base64"), { mode: 0o600 });
  return path;
}

async function printResult(result: ComputerResult, requestedScreenshotPath?: string): Promise<number> {
  let output = result.output;
  if (result.image) {
    const screenshotPath = await saveScreenshot(result.image, requestedScreenshotPath);
    const withPath = output.replace(/(^\s*screenshot:) included$/m, `$1 ${screenshotPath}`);
    output = withPath === output ? `${output}\nScreenshot: ${screenshotPath}` : withPath;
  }
  const stream = result.isError ? process.stderr : process.stdout;
  stream.write(output.endsWith("\n") ? output : output + "\n");
  return result.isError ? 1 : 0;
}

export async function run(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  const command = argv[0]!;
  const parsed = parseArgs(argv.slice(1));
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const result = await dispatch(command, parsed, controller.signal);
    return await printResult(result, optionString(parsed, "screenshot"));
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`computer: ${error.message}\nTry 'computer -h' for usage.\n`);
      process.exitCode = 2;
    } else if (error instanceof DOMException && error.name === "AbortError") {
      process.stderr.write("computer: interrupted\n");
      process.exitCode = 130;
    } else {
      process.stderr.write(`computer: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
