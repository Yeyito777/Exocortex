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
    output: `Computer Use dwm backend currently supports only target=host. Received target=${JSON.stringify(target)}.`,
    isError: true,
  };
}

function socketUnavailableMessage(path: string, err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  const exists = existsSync(path);
  return [
    `Could not connect to dwm IPC socket: ${path}`,
    `Reason: ${reason}`,
    exists ? "The socket exists but did not accept the request." : "The socket does not exist. Make sure host dwm is running the exocortex-computer-use-ipc branch/build.",
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
      settle(() => reject(new Error("dwm IPC request aborted")));
    }

    const timer = setTimeout(() => {
      socket?.destroy();
      settle(() => reject(new Error(`dwm IPC request timed out after ${DWM_IPC_TIMEOUT_MS}ms`)));
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
            reject(new Error(parsed.error || `dwm IPC method ${method} failed`));
            return;
          }
          if (parsed.result === undefined) {
            reject(new Error(`dwm IPC method ${method} returned no result`));
            return;
          }
          resolve(parsed.result);
        } catch (err) {
          reject(new Error(`Invalid dwm IPC response for ${method}: ${err instanceof Error ? err.message : String(err)}\n${data.slice(0, 500)}`));
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

function clientLabel(c: DwmClient): string {
  const name = c.title || c.class || c.instance || c.win;
  const classPart = c.class ? ` class=${c.class}` : "";
  const state = [
    c.visible ? "visible" : "hidden",
    c.focused ? "focused" : null,
    c.fullscreen ? "fullscreen" : null,
    c.floating ? "floating" : null,
  ].filter(Boolean).join(",");
  return `${name} — win=${c.win} pid=${c.pid}${classPart} mon=${c.monitor} tags=0x${c.tags.toString(16)} [${state}] geom=${c.geometry.x},${c.geometry.y} ${c.geometry.w}×${c.geometry.h}`;
}

function formatClientList(clients: DwmClient[]): string {
  if (clients.length === 0) return "No dwm-managed clients/windows found.";
  const lines = [`dwm clients (${clients.length}):`];
  for (const c of clients) lines.push(`- ${clientLabel(c)}`);
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
    return focused ? { client: focused, clients } : { error: "No focused dwm client found." };
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
      `No dwm client matched app target ${JSON.stringify(app)}.`,
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
      throw new Error(`Failed to build computer-use X11 helper:\n${result.stderr || result.stdout.toString("utf8")}`);
    }
    await chmod(out, 0o755).catch(() => {});
  }
  return out;
}

async function runX11Helper(args: string[], signal?: AbortSignal): Promise<void> {
  const helper = await x11HelperPath();
  const result = await runCommand(helper, args, signal);
  if (result.exitCode !== 0) {
    throw new Error(`X11 background input helper failed (${args.join(" ")}):\n${result.stderr || result.stdout.toString("utf8") || `exit ${result.exitCode}`}`);
  }
}

async function trustedXorgInputAvailable(signal?: AbortSignal): Promise<boolean> {
  try {
    const helper = await x11HelperPath();
    const result = await runCommand(helper, ["probe"], signal);
    return result.exitCode === 0 && result.stdout.toString("utf8").includes("available");
  } catch {
    return false;
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
  let backend = "maim";
  if (result.exitCode !== 0 || result.stdout.length === 0) {
    // ImageMagick import is less reliable for off-screen dwm windows, but it is
    // a useful fallback on systems without maim.
    result = await runMagick(["import", "-silent", "-display", displayNameForX11(), "-window", win, "png:-"], signal);
    backend = "ImageMagick import";
  }
  if (result.exitCode !== 0 || result.stdout.length === 0) {
    return {
      note: `Screenshot capture failed for ${win}: ${result.stderr.trim() || `${backend} exited ${result.exitCode}`}`,
      isError: true,
    };
  }

  const base64 = result.stdout.toString("base64");
  if (base64.length <= MAX_INLINE_SCREENSHOT_BASE64) {
    return {
      image: { mediaType: "image/png", base64 },
      note: `Screenshot captured from ${win} via ${backend} (${(result.stdout.length / 1024).toFixed(0)} KiB PNG).`,
    };
  }

  const compressed = await compressScreenshot(result.stdout, signal);
  if ("error" in compressed) return { note: compressed.error, isError: true };
  return {
    image: compressed,
    note: `Screenshot captured from ${win} and compressed to ${(Math.ceil(compressed.base64.length * 3 / 4) / 1024).toFixed(0)} KiB JPEG.`,
  };
}

function renderAppState(client: DwmClient, monitors: DwmMonitor[], screenshotNote: string | null, extraStateLines: string[] = []): string {
  const g = client.geometry;
  const monitor = monitors.find((m) => m.num === client.monitor);
  const lines = [
    "Computer Use state",
    "Backend: dwm IPC + targeted X11 events (patched Xorg trusted path when available; AT-SPI accessibility is pending)",
    "Coordinate space: window-relative pixels for future action tools; screenshot origin is the target window content area as captured by X11.",
    screenshotNote ? `Screenshot: ${screenshotNote}` : null,
    "",
    "<app_state>",
    `0 window ${JSON.stringify(client.title || client.class || client.win)}`,
    `  win: ${client.win}`,
    `  pid: ${client.pid}`,
    `  class: ${client.class ?? ""}`,
    `  instance: ${client.instance ?? ""}`,
    `  monitor: ${client.monitor}${monitor ? ` (${monitor.screen.w}×${monitor.screen.h}+${monitor.screen.x}+${monitor.screen.y})` : ""}`,
    `  tags: 0x${client.tags.toString(16)} selectedTags: 0x${client.selectedTags.toString(16)}`,
    `  visible: ${client.visible} focused: ${client.focused}`,
    `  floating: ${client.floating} fullscreen: ${client.fullscreen}`,
    `  geometry: x=${g.x} y=${g.y} w=${g.w} h=${g.h} border=${g.border}`,
    client.aiToken ? `  aiToken: ${client.aiToken}` : null,
    ...extraStateLines,
    "  accessibility: not wired yet (element_index/set_value/secondary actions unavailable until AT-SPI backend lands)",
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
  const mode = "Input mode: Exocortex sends targeted background input to the target window (trusted Xorg extension when available, otherwise X11/app fallback); dwm focus/tag was not changed by Exocortex.";
  return {
    ...state,
    output: [
      prefix,
      mode,
      "Note: some applications/toolkits may ignore synthetic background events; if so, AT-SPI or app-specific backends will be needed.",
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
  return { output: "computer_set_value requires the upcoming generic AT-SPI/accessibility backend; app-specific DOM backends are disabled.", isError: true };
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
  return { output: "computer_perform_secondary_action requires the upcoming generic AT-SPI/accessibility backend; app-specific DOM backends are disabled.", isError: true };
}

export async function executeComputerClick(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const resolved = await resolveActionTarget(input, signal);
  if (isToolResult(resolved)) return resolved;

  const trustedInput = await trustedXorgInputAvailable(signal);

  const x = numericInput(input, "x");
  const y = numericInput(input, "y");
  const elementIndex = parseElementIndex(getString(input, "element_index"));
  if (elementIndex != null && (x == null || y == null)) {
    return { output: "element_index clicks require the upcoming generic AT-SPI/accessibility backend to map the element to coordinates.", isError: true };
  }
  if (x == null || y == null) {
    return { output: "computer_click currently requires window-relative x and y coordinates because AT-SPI element targeting is not wired yet.", isError: true };
  }

  const button = getString(input, "mouse_button") ?? "left";
  const count = Math.max(1, Math.min(3, numericInput(input, "click_count") ?? 1));
  try {
    await runX11Helper(["click", resolved.client.win, String(x), String(y), button, String(count)], signal);
    return actionState(`${trustedInput ? "Trusted Xorg" : "Background X11"} click sent to ${resolved.client.win} at ${x},${y} (${button}, count=${count}).`, resolved.client, signal);
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
    return actionState(`Background drag sent to ${resolved.client.win}: ${fromX},${fromY} → ${toX},${toY}.`, resolved.client, signal);
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
    const trustedInput = await trustedXorgInputAvailable(signal);
    await runX11Helper(["type", resolved.client.win, text], signal);
    return actionState(`${trustedInput ? "Trusted Xorg" : "Background X11"} text typing sent to ${resolved.client.win} (${text.length} chars).`, resolved.client, signal);
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
    const trustedInput = await trustedXorgInputAvailable(signal);
    await runX11Helper(["key", resolved.client.win, key], signal);
    return actionState(`${trustedInput ? "Trusted Xorg" : "Background X11"} key ${JSON.stringify(key)} sent to ${resolved.client.win}.`, resolved.client, signal);
  } catch (err) {
    return { output: err instanceof Error ? err.message : String(err), isError: true };
  }
}

export async function executeComputerScroll(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const resolved = await resolveActionTarget(input, signal);
  if (isToolResult(resolved)) return resolved;
  const trustedInput = await trustedXorgInputAvailable(signal);
  if (getString(input, "element_index")) {
    return { output: "element_index scrolling requires the upcoming AT-SPI backend. For now scrolling targets the window center.", isError: true };
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
    return actionState(`${trustedInput ? "Trusted Xorg" : "Background X11"} scroll ${direction} x${pages} sent to ${resolved.client.win}.`, resolved.client, signal);
  } catch (err) {
    return { output: err instanceof Error ? err.message : String(err), isError: true };
  }
}

export async function executeUnsupportedComputerAction(input: Record<string, unknown>): Promise<ToolResult> {
  const app = getString(input, "app") ?? "target app";
  return {
    output: [
      `Computer Use action is not wired yet for ${app}.`,
      "Currently wired: dwm IPC list_apps/get_app_state and direct X11 background click/type/key/scroll/drag.",
      "Pending backend: AT-SPI for element_index/set_value/secondary accessibility actions.",
    ].join("\n"),
    isError: true,
  };
}
