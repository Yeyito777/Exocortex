import { existsSync } from "fs";
import { chmod, mkdir, mkdtemp, rmdir, stat, unlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createConnection, type Socket } from "net";
import { runtimeDir } from "@exocortex/shared/paths";
import type { ToolResult } from "../tools/types";

const DWM_IPC_TIMEOUT_MS = 2_000;
const MAX_INLINE_SCREENSHOT_BASE64 = 5 * 1024 * 1024;
const MAX_SCREENSHOT_DIMENSION = 2000;

export interface DwmGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
  border: number;
}

export interface DwmClient {
  win: string;
  pid: number;
  title: string;
  class: string | null;
  instance: string | null;
  monitor: number;
  tags: number;
  selectedTags: number;
  visible: boolean;
  focused: boolean;
  floating: boolean;
  fullscreen: boolean;
  geometry: DwmGeometry;
  aiToken: string | null;
  aiLabel: string | null;
  isWidget: boolean;
  neverFocus: boolean;
  noFocusManage: boolean;
}

interface DwmMonitor {
  num: number;
  focused: boolean;
  numTags: number;
  selectedTags: number;
  screen: DwmGeometry;
  workarea: DwmGeometry;
  selectedClient: string | null;
}

interface DwmTag {
  monitor: number;
  index: number;
  bit: number;
  name: string;
  selected: boolean;
  occupied: number;
  aiManaged: boolean;
  aiToken: string | null;
  aiLabel: string | null;
}

interface DwmResponse<T> {
  id: unknown;
  ok: boolean;
  result?: T;
  error?: string;
}

interface DwmListClientsResult {
  clients: DwmClient[];
}

interface DwmListMonitorsResult {
  monitors: DwmMonitor[];
}

interface DwmListTagsResult {
  tags: DwmTag[];
}

interface DwmTagMutationResult {
  action: "created" | "deleted";
  tag?: DwmTag;
  monitor?: number;
  index?: number;
  bit?: number;
  numTags: number;
  selectedTags: number;
}

interface ResolvedApp {
  client: DwmClient;
  clients: DwmClient[];
}

function getString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getBoolean(input: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = input[key];
  return typeof value === "boolean" ? value : fallback;
}

function getNumber(input: Record<string, unknown>, key: string): number | null {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getInteger(input: Record<string, unknown>, key: string): number | null {
  const value = getNumber(input, key);
  return value == null ? null : Math.round(value);
}

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function displaySocketName(): string {
  const override = process.env.DWM_IPC_SOCKET?.trim();
  if (override) return override;

  const runtime = process.env.XDG_RUNTIME_DIR?.trim() || "/tmp";
  const display = process.env.DISPLAY?.trim() || "unknown";
  if (display === "unknown") return join(runtime, "dwm-_0.sock");
  const clean = [...display].map((ch) => /[A-Za-z0-9_.-]/.test(ch) ? ch : "_").join("");
  return join(runtime, `dwm-${clean}.sock`);
}

function displayNameForX11(): string {
  const configured = process.env.DISPLAY?.trim();
  if (configured) return configured;

  // Match the default dwm IPC socket convention: DISPLAY=:0 -> dwm-_0.sock.
  const socket = displaySocketName();
  const match = /dwm-_([0-9]+)(?:\.[0-9]+)?\.sock$/.exec(socket);
  if (match) return `:${match[1]}`;

  // Host-dwm computer use is a foreground desktop feature; :0 is the common
  // local display and keeps screenshot capture working when exocortexd was
  // started by a service environment that has XDG_RUNTIME_DIR but no DISPLAY.
  return ":0";
}

function x11Environment(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, DISPLAY: displayNameForX11() };
  if (!env.XAUTHORITY) {
    const home = process.env.HOME;
    if (home) env.XAUTHORITY = join(home, ".Xauthority");
  }
  return env;
}

function targetError(target: string | null): ToolResult | null {
  if (!target || target === "host") return null;
  return {
    output: `Computer Use currently supports only target=host. Received target=${JSON.stringify(target)}.`,
    isError: true,
  };
}

function socketUnavailableMessage(path: string, err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  const exists = existsSync(path);
  return [
    "Could not connect to the desktop window list.",
    exists ? "The desktop control socket exists but did not accept the request." : "The desktop control socket does not exist.",
    `Reason: ${reason}`,
  ].join("\n");
}

async function callDwm<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  const socketPath = displaySocketName();
  const id = Date.now();
  const payload = JSON.stringify({ id, method, ...params }) + "\n";

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let data = "";
    let socket: Socket | null = null;

    function settle(fn: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    }

    function onAbort(): void {
      socket?.destroy();
      settle(() => reject(new Error("Desktop window request aborted")));
    }

    const timer = setTimeout(() => {
      socket?.destroy();
      settle(() => reject(new Error(`Desktop window request timed out after ${DWM_IPC_TIMEOUT_MS}ms`)));
    }, DWM_IPC_TIMEOUT_MS);

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket?.write(payload));
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("error", (err) => {
      settle(() => reject(new Error(socketUnavailableMessage(socketPath, err))));
    });
    socket.on("end", () => {
      settle(() => {
        try {
          const parsed = JSON.parse(data.trim()) as DwmResponse<T>;
          if (!parsed.ok) {
            reject(new Error(parsed.error || "Desktop window request failed"));
            return;
          }
          if (parsed.result === undefined) {
            reject(new Error("Desktop window request returned no result"));
            return;
          }
          resolve(parsed.result);
        } catch (err) {
          reject(new Error(`Invalid desktop window response: ${err instanceof Error ? err.message : String(err)}\n${data.slice(0, 500)}`));
        }
      });
    });
  });
}

async function listDwmClients(signal?: AbortSignal): Promise<DwmClient[]> {
  const result = await callDwm<DwmListClientsResult>("clients/list", {}, signal);
  return Array.isArray(result.clients) ? result.clients : [];
}

async function listDwmMonitors(signal?: AbortSignal): Promise<DwmMonitor[]> {
  const result = await callDwm<DwmListMonitorsResult>("monitors/list", {}, signal);
  return Array.isArray(result.monitors) ? result.monitors : [];
}

async function listDwmTags(signal?: AbortSignal): Promise<DwmTag[]> {
  const result = await callDwm<DwmListTagsResult>("tags/list", {}, signal);
  return Array.isArray(result.tags) ? result.tags : [];
}

function clientLabel(c: DwmClient): string {
  const name = c.title || c.class || c.instance || c.win;
  const classPart = c.class ? ` class=${c.class}` : "";
  const state = [
    c.visible ? "visible" : "hidden",
    c.focused ? "focused" : null,
    c.fullscreen ? "fullscreen" : null,
    c.floating ? "floating" : null,
  ].filter(Boolean).join(",");
  return `${JSON.stringify(name)} id=${c.win} pid=${c.pid}${classPart} [${state}] bounds=${c.geometry.x},${c.geometry.y} ${c.geometry.w}×${c.geometry.h}`;
}

function formatClientList(clients: DwmClient[]): string {
  if (clients.length === 0) return "No windows found.";
  const lines = [`Windows (${clients.length}):`];
  for (const c of clients) lines.push(`- ${clientLabel(c)}`);
  return lines.join("\n");
}

function tagLabel(t: DwmTag): string {
  const state = [
    t.selected ? "selected" : null,
    t.occupied > 0 ? `${t.occupied} window${t.occupied === 1 ? "" : "s"}` : "empty",
    t.aiManaged ? "ai-managed" : null,
  ].filter(Boolean).join(",");
  const label = t.aiLabel ? ` label=${JSON.stringify(t.aiLabel)}` : "";
  return `monitor=${t.monitor} index=${t.index} name=${JSON.stringify(t.name)} bit=${t.bit}${label} [${state}]`;
}

function formatTagList(tags: DwmTag[]): string {
  if (tags.length === 0) return "No tags found.";
  const lines = [`Tags (${tags.length}):`];
  for (const t of tags) lines.push(`- ${tagLabel(t)}`);
  return lines.join("\n");
}

function exactWindowMatch(c: DwmClient, query: string): boolean {
  const q = normalize(query);
  if (normalize(c.win) === q || normalize(c.win.replace(/^0x0+/, "0x")) === q.replace(/^0x0+/, "0x")) return true;
  if (/^\d+$/.test(q)) {
    const decimal = Number(q);
    const winNumber = Number.parseInt(c.win, 16);
    if (Number.isFinite(decimal) && decimal === winNumber) return true;
  }
  return false;
}

function clientFields(c: DwmClient): string[] {
  return [c.title, c.class, c.instance, c.win, String(c.pid)].filter((v): v is string => typeof v === "string" && v.length > 0);
}

function chooseBest(candidates: DwmClient[]): DwmClient | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const focused = candidates.filter((c) => c.focused);
  if (focused.length === 1) return focused[0];
  const visible = candidates.filter((c) => c.visible);
  if (visible.length === 1) return visible[0];
  return null;
}

function resolveFromClients(clients: DwmClient[], app: string): ResolvedApp | { error: string } {
  const query = app.trim();
  const q = normalize(query);
  if (!q) return { error: "Missing app target." };

  if (["focused", "active", "current", "frontmost"].includes(q)) {
    const focused = clients.find((c) => c.focused);
    return focused ? { client: focused, clients } : { error: "No focused window found." };
  }

  let matches = clients.filter((c) => exactWindowMatch(c, query));
  let chosen = chooseBest(matches);
  if (chosen) return { client: chosen, clients };

  if (/^\d+$/.test(query)) {
    const pid = Number(query);
    matches = clients.filter((c) => c.pid === pid);
    chosen = chooseBest(matches);
    if (chosen) return { client: chosen, clients };
  }

  matches = clients.filter((c) => [c.title, c.class, c.instance].some((field) => normalize(field) === q));
  chosen = chooseBest(matches);
  if (chosen) return { client: chosen, clients };

  matches = clients.filter((c) => clientFields(c).some((field) => normalize(field).includes(q)));
  chosen = chooseBest(matches);
  if (chosen) return { client: chosen, clients };

  if (matches.length > 1) {
    return {
      error: [
        `Ambiguous app target ${JSON.stringify(app)} matched ${matches.length} windows. Use a window id or PID.`,
        formatClientList(matches),
      ].join("\n"),
    };
  }

  return {
    error: [
      `No window matched app target ${JSON.stringify(app)}.`,
      formatClientList(clients),
    ].join("\n"),
  };
}

async function resolveApp(app: string, signal?: AbortSignal): Promise<ResolvedApp | { error: string }> {
  const clients = await listDwmClients(signal);
  return resolveFromClients(clients, app);
}

async function runCommand(command: string, args: string[], signal?: AbortSignal): Promise<{ exitCode: number; stdout: Buffer; stderr: string }> {
  const proc = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe", env: x11Environment() });
  const onAbort = (): void => proc.kill();
  if (signal?.aborted) proc.kill();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const stdoutPromise = new Response(proc.stdout).arrayBuffer();
    const stderrPromise = new Response(proc.stderr).text();
    const [stdout, stderr, exitCode] = await Promise.all([stdoutPromise, stderrPromise, proc.exited]);
    return { exitCode, stdout: Buffer.from(stdout), stderr };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function parseElementIndex(value: string | null): number | null {
  if (!value) return null;
  const match = /^(?:dom:)?(\d+)$/.exec(value.trim());
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function runMagick(args: string[], signal?: AbortSignal): Promise<{ exitCode: number; stdout: Buffer; stderr: string }> {
  return runCommand("magick", args, signal);
}

async function x11HelperPath(): Promise<string> {
  const source = join(import.meta.dir, "x11-send.c");
  const out = join(runtimeDir(), "computer-use-x11-send");
  await mkdir(runtimeDir(), { recursive: true });

  const [srcStat, outStat] = await Promise.all([
    stat(source),
    stat(out).catch(() => null),
  ]);
  if (!outStat || outStat.mtimeMs < srcStat.mtimeMs) {
    const result = await runCommand("cc", [source, "-O2", "-Wall", "-o", out, "-lX11"]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to build desktop input helper:\n${result.stderr || result.stdout.toString("utf8")}`);
    }
    await chmod(out, 0o755).catch(() => {});
  }
  return out;
}

async function runX11Helper(args: string[], signal?: AbortSignal): Promise<void> {
  const helper = await x11HelperPath();
  const result = await runCommand(helper, args, signal);
  if (result.exitCode !== 0) {
    throw new Error(`Desktop input helper failed (${args.join(" ")}):\n${result.stderr || result.stdout.toString("utf8") || `exit ${result.exitCode}`}`);
  }
}

async function compressScreenshot(raw: Buffer, signal?: AbortSignal): Promise<{ mediaType: string; base64: string } | { error: string }> {
  const dir = await mkdtemp(join(tmpdir(), "exocortex-computer-use-"));
  const input = join(dir, "screenshot.png");
  try {
    await writeFile(input, raw);
    for (const quality of [85, 65, 45]) {
      const result = await runMagick([input, "-resize", `${MAX_SCREENSHOT_DIMENSION}x${MAX_SCREENSHOT_DIMENSION}>`, "-quality", String(quality), "jpg:-"], signal);
      if (result.exitCode !== 0) continue;
      const base64 = result.stdout.toString("base64");
      if (base64.length <= MAX_INLINE_SCREENSHOT_BASE64) return { mediaType: "image/jpeg", base64 };
    }
    return { error: `Screenshot is too large after compression (${(raw.length / (1024 * 1024)).toFixed(1)} MB raw).` };
  } finally {
    await unlink(input).catch(() => {});
    await rmdir(dir).catch(() => {});
  }
}

async function captureWindow(win: string, signal?: AbortSignal): Promise<{ image?: { mediaType: string; base64: string }; note: string; isError?: boolean }> {
  let result = await runCommand("maim", ["-x", displayNameForX11(), "-u", "-i", win, "-f", "png"], signal);
  if (result.exitCode !== 0 || result.stdout.length === 0) {
    result = await runMagick(["import", "-silent", "-display", displayNameForX11(), "-window", win, "png:-"], signal);
  }
  if (result.exitCode !== 0 || result.stdout.length === 0) {
    return {
      note: "unavailable",
      isError: true,
    };
  }

  const base64 = result.stdout.toString("base64");
  if (base64.length <= MAX_INLINE_SCREENSHOT_BASE64) {
    return {
      image: { mediaType: "image/png", base64 },
      note: "included",
    };
  }

  const compressed = await compressScreenshot(result.stdout, signal);
  if ("error" in compressed) return { note: compressed.error, isError: true };
  return {
    image: compressed,
    note: "included",
  };
}

function renderAppState(client: DwmClient, monitors: DwmMonitor[], screenshotNote: string | null, extraStateLines: string[] = []): string {
  const g = client.geometry;
  const monitor = monitors.find((m) => m.num === client.monitor);
  const lines = [
    "<app_state>",
    `0 window ${JSON.stringify(client.title || client.class || client.win)}`,
    `  id: ${client.win}`,
    `  pid: ${client.pid}`,
    `  class: ${client.class ?? ""}`,
    `  instance: ${client.instance ?? ""}`,
    monitor ? `  screen: ${monitor.screen.w}×${monitor.screen.h}+${monitor.screen.x}+${monitor.screen.y}` : null,
    `  visible: ${client.visible} focused: ${client.focused}`,
    `  floating: ${client.floating} fullscreen: ${client.fullscreen}`,
    `  bounds: x=${g.x} y=${g.y} w=${g.w} h=${g.h}`,
    screenshotNote ? `  screenshot: ${screenshotNote}` : null,
    ...extraStateLines,
    "</app_state>",
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

export async function executeComputerListApps(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const target = getString(input, "target");
  const unsupported = targetError(target);
  if (unsupported) return unsupported;

  try {
    const clients = await listDwmClients(signal);
    return { output: formatClientList(clients), isError: false };
  } catch (err) {
    return { output: err instanceof Error ? err.message : String(err), isError: true };
  }
}

export async function executeComputerListTags(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const target = getString(input, "target");
  const unsupported = targetError(target);
  if (unsupported) return unsupported;

  try {
    const tags = await listDwmTags(signal);
    return { output: formatTagList(tags), isError: false };
  } catch (err) {
    return { output: err instanceof Error ? err.message : String(err), isError: true };
  }
}

function tagMutationParams(input: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const monitor = getInteger(input, "monitor");
  const index = getInteger(input, "index");
  const position = getInteger(input, "position");
  const side = getString(input, "side");
  const select = input.select;
  const force = input.force;

  if (monitor != null) params.monitor = monitor;
  if (index != null) params.index = index;
  if (position != null) params.position = position;
  if (side) params.side = side;
  if (typeof select === "boolean") params.select = select;
  if (typeof force === "boolean") params.force = force;
  return params;
}

export async function executeComputerCreateTag(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const target = getString(input, "target");
  const unsupported = targetError(target);
  if (unsupported) return unsupported;

  try {
    const result = await callDwm<DwmTagMutationResult>("tag/create", tagMutationParams(input), signal);
    const lines = [
      `Created tag${result.tag ? ` ${JSON.stringify(result.tag.name)}` : ""}.`,
      result.tag ? tagLabel(result.tag) : null,
      `numTags=${result.numTags} selectedTags=${result.selectedTags}`,
      "",
      formatTagList(await listDwmTags(signal)),
    ].filter((line): line is string => line !== null);
    return { output: lines.join("\n"), isError: false };
  } catch (err) {
    return { output: err instanceof Error ? err.message : String(err), isError: true };
  }
}

export async function executeComputerDeleteTag(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const target = getString(input, "target");
  const unsupported = targetError(target);
  if (unsupported) return unsupported;

  try {
    const result = await callDwm<DwmTagMutationResult>("tag/delete", tagMutationParams(input), signal);
    const parts = [
      result.monitor != null ? `monitor=${result.monitor}` : null,
      result.index != null ? `index=${result.index}` : null,
      result.bit != null ? `bit=${result.bit}` : null,
    ].filter(Boolean).join(" ");
    const lines = [
      `Deleted tag${parts ? ` (${parts})` : ""}.`,
      `numTags=${result.numTags} selectedTags=${result.selectedTags}`,
      "",
      formatTagList(await listDwmTags(signal)),
    ];
    return { output: lines.join("\n"), isError: false };
  } catch (err) {
    return { output: err instanceof Error ? err.message : String(err), isError: true };
  }
}

export async function executeComputerGetAppState(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const target = getString(input, "target");
  const unsupported = targetError(target);
  if (unsupported) return unsupported;

  const app = getString(input, "app");
  if (!app) return { output: "computer_get_app_state requires app.", isError: true };
  const includeScreenshot = getBoolean(input, "include_screenshot", true);

  try {
    const resolved = await resolveApp(app, signal);
    if ("error" in resolved) return { output: resolved.error, isError: true };

    let image: ToolResult["image"] | undefined;
    let screenshotNote: string | null = null;
    if (includeScreenshot) {
      const shot = await captureWindow(resolved.client.win, signal);
      image = shot.image;
      screenshotNote = shot.note;
    }

    const extraStateLines: string[] = [];

    const monitors = await listDwmMonitors(signal).catch(() => []);
    const output = renderAppState(resolved.client, monitors, screenshotNote, extraStateLines);
    return { output, isError: false, image };
  } catch (err) {
    return { output: err instanceof Error ? err.message : String(err), isError: true };
  }
}

function numericInput(input: Record<string, unknown>, key: string): number | null {
  const value = getNumber(input, key);
  return value == null ? null : Math.round(value);
}

async function resolveActionTarget(input: Record<string, unknown>, signal?: AbortSignal): Promise<ResolvedApp | ToolResult> {
  const target = getString(input, "target");
  const unsupported = targetError(target);
  if (unsupported) return unsupported;
  const app = getString(input, "app");
  if (!app) return { output: "Computer Use action requires app.", isError: true };
  try {
    const resolved = await resolveApp(app, signal);
    if ("error" in resolved) return { output: resolved.error, isError: true };
    return resolved;
  } catch (err) {
    return { output: err instanceof Error ? err.message : String(err), isError: true };
  }
}

function isToolResult(value: ResolvedApp | ToolResult): value is ToolResult {
  return "isError" in value;
}

async function actionState(prefix: string, client: DwmClient, signal?: AbortSignal): Promise<ToolResult> {
  const state = await executeComputerGetAppState({ app: client.win, include_screenshot: true }, signal);
  return {
    ...state,
    output: [
      prefix,
      "",
      state.output,
    ].join("\n"),
  };
}

export async function executeComputerSetValue(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const resolved = await resolveActionTarget(input, signal);
  if (isToolResult(resolved)) return resolved;
  const elementIndex = parseElementIndex(getString(input, "element_index"));
  const value = typeof input.value === "string" ? input.value : null;
  if (elementIndex == null) return { output: "computer_set_value requires a numeric element_index from computer_get_app_state.", isError: true };
  if (value == null) return { output: "computer_set_value requires value.", isError: true };
  void resolved;
  void elementIndex;
  void value;
  return { output: "computer_set_value requires a generic accessibility backend that is not wired yet.", isError: true };
}

export async function executeComputerPerformSecondaryAction(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const resolved = await resolveActionTarget(input, signal);
  if (isToolResult(resolved)) return resolved;
  const action = normalize(getString(input, "action"));
  const elementIndex = parseElementIndex(getString(input, "element_index"));
  if (!action) return { output: "computer_perform_secondary_action requires action.", isError: true };
  if (elementIndex == null) return { output: "computer_perform_secondary_action requires a numeric element_index from computer_get_app_state.", isError: true };
  void resolved;
  void action;
  void elementIndex;
  return { output: "computer_perform_secondary_action requires a generic accessibility backend that is not wired yet.", isError: true };
}

export async function executeComputerClick(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const resolved = await resolveActionTarget(input, signal);
  if (isToolResult(resolved)) return resolved;

  const x = numericInput(input, "x");
  const y = numericInput(input, "y");
  const elementIndex = parseElementIndex(getString(input, "element_index"));
  if (elementIndex != null && (x == null || y == null)) {
    return { output: "element_index clicks require a generic accessibility backend to map the element to coordinates.", isError: true };
  }
  if (x == null || y == null) {
    return { output: "computer_click requires window-relative x and y coordinates.", isError: true };
  }

  const button = getString(input, "mouse_button") ?? "left";
  const count = Math.max(1, Math.min(3, numericInput(input, "click_count") ?? 1));
  try {
    await runX11Helper(["click", resolved.client.win, String(x), String(y), button, String(count)], signal);
    return actionState(`Clicked at ${x},${y} (${button}, count=${count}).`, resolved.client, signal);
  } catch (err) {
    return { output: err instanceof Error ? err.message : String(err), isError: true };
  }
}

export async function executeComputerHoldClick(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const resolved = await resolveActionTarget(input, signal);
  if (isToolResult(resolved)) return resolved;

  const x = numericInput(input, "x");
  const y = numericInput(input, "y");
  if (x == null || y == null) {
    return { output: "computer_hold_click requires window-relative x and y coordinates.", isError: true };
  }

  const button = getString(input, "mouse_button") ?? "left";
  const duration = Math.max(1, Math.min(30_000, numericInput(input, "duration_ms") ?? 1000));
  try {
    await runX11Helper(["hold", resolved.client.win, String(x), String(y), button, String(duration)], signal);
    return actionState(`Held ${button} click at ${x},${y} for ${duration}ms.`, resolved.client, signal);
  } catch (err) {
    return { output: err instanceof Error ? err.message : String(err), isError: true };
  }
}

export async function executeComputerMoveRelative(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const resolved = await resolveActionTarget(input, signal);
  if (isToolResult(resolved)) return resolved;

  const dx = numericInput(input, "dx");
  const dy = numericInput(input, "dy");
  if (dx == null || dy == null) {
    return { output: "computer_move_relative requires dx and dy relative mouse deltas.", isError: true };
  }

  const steps = Math.max(1, Math.min(200, numericInput(input, "steps") ?? 1));
  try {
    await runX11Helper(["move-relative", resolved.client.win, String(dx), String(dy), String(steps)], signal);
    return actionState(`Moved pointer input relatively by dx=${dx}, dy=${dy} (${steps} step${steps === 1 ? "" : "s"}).`, resolved.client, signal);
  } catch (err) {
    return { output: err instanceof Error ? err.message : String(err), isError: true };
  }
}

export async function executeComputerDrag(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const resolved = await resolveActionTarget(input, signal);
  if (isToolResult(resolved)) return resolved;
  const fromX = numericInput(input, "from_x");
  const fromY = numericInput(input, "from_y");
  const toX = numericInput(input, "to_x");
  const toY = numericInput(input, "to_y");
  if ([fromX, fromY, toX, toY].some((value) => value == null)) {
    return { output: "computer_drag requires from_x, from_y, to_x, and to_y.", isError: true };
  }
  try {
    await runX11Helper(["drag", resolved.client.win, String(fromX), String(fromY), String(toX), String(toY)], signal);
    return actionState(`Dragged from ${fromX},${fromY} to ${toX},${toY}.`, resolved.client, signal);
  } catch (err) {
    return { output: err instanceof Error ? err.message : String(err), isError: true };
  }
}

export async function executeComputerTypeText(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const resolved = await resolveActionTarget(input, signal);
  if (isToolResult(resolved)) return resolved;
  const text = typeof input.text === "string" ? input.text : null;
  if (text == null) return { output: "computer_type_text requires text.", isError: true };
  try {
    await runX11Helper(["type", resolved.client.win, text], signal);
    return actionState(`Typed text (${text.length} chars).`, resolved.client, signal);
  } catch (err) {
    return { output: err instanceof Error ? err.message : String(err), isError: true };
  }
}

export async function executeComputerPressKey(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const resolved = await resolveActionTarget(input, signal);
  if (isToolResult(resolved)) return resolved;
  const key = getString(input, "key");
  if (!key) return { output: "computer_press_key requires key.", isError: true };
  try {
    await runX11Helper(["key", resolved.client.win, key], signal);
    return actionState(`Pressed key ${JSON.stringify(key)}.`, resolved.client, signal);
  } catch (err) {
    return { output: err instanceof Error ? err.message : String(err), isError: true };
  }
}

export async function executeComputerScroll(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const resolved = await resolveActionTarget(input, signal);
  if (isToolResult(resolved)) return resolved;
  if (getString(input, "element_index")) {
    return { output: "element_index scrolling requires a generic accessibility backend. For now scrolling targets the window center.", isError: true };
  }
  const direction = getString(input, "direction");
  if (!direction || !["up", "down", "left", "right"].includes(direction)) {
    return { output: "computer_scroll requires direction: up, down, left, or right.", isError: true };
  }
  const pages = Math.max(1, Math.min(20, numericInput(input, "pages") ?? 1));
  const x = Math.round(resolved.client.geometry.w / 2);
  const y = Math.round(resolved.client.geometry.h / 2);
  try {
    await runX11Helper(["scroll", resolved.client.win, direction, String(pages), String(x), String(y)], signal);
    return actionState(`Scrolled ${direction} x${pages}.`, resolved.client, signal);
  } catch (err) {
    return { output: err instanceof Error ? err.message : String(err), isError: true };
  }
}

export async function executeUnsupportedComputerAction(input: Record<string, unknown>): Promise<ToolResult> {
  const app = getString(input, "app") ?? "target app";
  return {
    output: [
      `Computer Use action is not wired yet for ${app}.`,
      "Currently wired: list_apps, get_app_state, click, type_text, press_key, scroll, drag.",
      "Pending: element_index, set_value, and secondary accessibility actions.",
    ].join("\n"),
    isError: true,
  };
}
