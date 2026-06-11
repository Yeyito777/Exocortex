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

interface VimbrowserStatus {
  active_tabid?: number;
  active_tab?: number;
  url?: string;
  title?: string;
  tabs?: unknown;
}

interface VimbrowserMetrics {
  innerWidth: number;
  innerHeight: number;
  outerWidth: number;
  outerHeight: number;
  devicePixelRatio: number;
  scrollX: number;
  scrollY: number;
  chromeLeft: number;
  chromeTop: number;
  chromeBottom: number;
  title: string;
  url: string;
}

interface VimbrowserElementInfo {
  index: number;
  tag: string;
  role: string;
  type: string;
  name: string;
  href: string;
  value: string;
  rect: { x: number; y: number; w: number; h: number };
  windowRect: { x: number; y: number; w: number; h: number };
}

interface VimbrowserDomState {
  metrics: VimbrowserMetrics;
  elements: VimbrowserElementInfo[];
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

function isVimbrowserClient(client: DwmClient): boolean {
  return [client.title, client.class, client.instance]
    .some((value) => normalize(value).includes("vimbrowser"));
}

async function runVimbrowserCli(args: string[], signal?: AbortSignal): Promise<{ stdout: Buffer; text: string }> {
  const result = await runCommand("vimbrowser-cli", args, signal);
  if (result.exitCode !== 0) {
    throw new Error(`vimbrowser-cli ${args.join(" ")} failed:\n${result.stderr || result.stdout.toString("utf8") || `exit ${result.exitCode}`}`);
  }
  return { stdout: result.stdout, text: result.stdout.toString("utf8") };
}

async function runVimbrowserJson<T>(args: string[], signal?: AbortSignal): Promise<T> {
  const { text } = await runVimbrowserCli(args, signal);
  return JSON.parse(text) as T;
}

async function vimbrowserActiveTab(signal?: AbortSignal): Promise<string> {
  const status = await runVimbrowserJson<VimbrowserStatus>(["status"], signal);
  const tab = status.active_tabid ?? status.active_tab;
  return tab == null ? "@active" : String(tab);
}

async function vimbrowserEvalJson<T>(script: string, signal?: AbortSignal): Promise<T> {
  const tab = await vimbrowserActiveTab(signal);
  const response = await runVimbrowserJson<{ ok?: boolean; type?: string; result?: string; error?: string }>(["js", tab, script], signal);
  if (response.ok === false) throw new Error(response.error || "vimbrowser JavaScript evaluation failed");
  if (typeof response.result !== "string") throw new Error(`vimbrowser JavaScript returned non-string result type ${response.type}`);
  return JSON.parse(response.result) as T;
}

function vimbrowserDomStateScript(maxElements: number): string {
  return `(() => {
    const limit = ${Math.max(1, Math.min(2000, Math.round(maxElements)))};
    const chromeLeft = Math.max(0, window.outerWidth - window.innerWidth);
    const chromeTop = 0;
    const chromeBottom = Math.max(0, window.outerHeight - window.innerHeight - chromeTop);
    const selector = [
      'a[href]', 'button', 'input', 'textarea', 'select', 'summary', 'video', 'audio',
      '[contenteditable="true"]', '[role="button"]', '[role="link"]', '[role="menuitem"]',
      '[onclick]', 'ytd-thumbnail', 'yt-lockup-view-model', 'yt-button-shape', 'tp-yt-paper-button'
    ].join(',');
    const visible = (el, rect) => {
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') return false;
      return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0 && rect.left <= innerWidth && rect.top <= innerHeight;
    };
    const nameOf = (el) => {
      const aria = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || '';
      const value = 'value' in el ? String(el.value || '') : '';
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      return (aria || value || text || el.getAttribute('href') || '').slice(0, 180);
    };
    const elements = [];
    const seen = new Set();
    for (const el of Array.from(document.querySelectorAll(selector))) {
      const target = el.closest('a[href],button,input,textarea,select,summary,video,audio,[contenteditable="true"],[role="button"],[role="link"],[role="menuitem"],[onclick]') || el;
      if (seen.has(target)) continue;
      seen.add(target);
      const rect = target.getBoundingClientRect();
      if (!visible(target, rect)) continue;
      const hrefEl = target.closest('a[href]');
      elements.push({
        index: elements.length + 1,
        tag: target.tagName.toLowerCase(),
        role: target.getAttribute('role') || '',
        type: target.getAttribute('type') || '',
        name: nameOf(target),
        href: hrefEl ? hrefEl.href : '',
        value: 'value' in target ? String(target.value || '').slice(0, 120) : '',
        rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
        windowRect: { x: Math.round(rect.left + chromeLeft), y: Math.round(rect.top + chromeTop), w: Math.round(rect.width), h: Math.round(rect.height) }
      });
      if (elements.length >= limit) break;
    }
    return JSON.stringify({
      metrics: {
        innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio,
        scrollX, scrollY, chromeLeft, chromeTop, chromeBottom,
        title: document.title, url: location.href
      },
      elements
    });
  })()`;
}

async function getVimbrowserDomState(maxElements: number, signal?: AbortSignal): Promise<VimbrowserDomState> {
  return vimbrowserEvalJson<VimbrowserDomState>(vimbrowserDomStateScript(maxElements), signal);
}

function vimbrowserClickScript(args: { x?: number; y?: number; elementIndex?: number }): string {
  const xExpr = typeof args.x === "number" ? String(Math.round(args.x)) : "null";
  const yExpr = typeof args.y === "number" ? String(Math.round(args.y)) : "null";
  const indexExpr = typeof args.elementIndex === "number" ? String(args.elementIndex) : "null";
  return `(() => {
    const requestedWindowX = ${xExpr};
    const requestedWindowY = ${yExpr};
    const requestedIndex = ${indexExpr};
    const chromeLeft = Math.max(0, window.outerWidth - window.innerWidth);
    const chromeTop = 0;
    const selector = [
      'a[href]', 'button', 'input', 'textarea', 'select', 'summary', 'video', 'audio',
      '[contenteditable="true"]', '[role="button"]', '[role="link"]', '[role="menuitem"]',
      '[onclick]', 'ytd-thumbnail', 'yt-lockup-view-model', 'yt-button-shape', 'tp-yt-paper-button'
    ].join(',');
    const closestClickable = (el) => el && (el.closest('a[href],button,input,textarea,select,summary,video,audio,[contenteditable="true"],[role="button"],[role="link"],[role="menuitem"],[onclick]') || el);
    const visible = (el, rect) => {
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0 && rect.left <= innerWidth && rect.top <= innerHeight;
    };
    const collect = () => {
      const out = [], seen = new Set();
      for (const el of Array.from(document.querySelectorAll(selector))) {
        const target = closestClickable(el);
        if (!target || seen.has(target)) continue;
        seen.add(target);
        const rect = target.getBoundingClientRect();
        if (!visible(target, rect)) continue;
        out.push(target);
      }
      return out;
    };
    let clientX, clientY, target;
    if (requestedIndex != null) {
      target = collect()[requestedIndex - 1];
      if (!target) return JSON.stringify({ ok: false, error: 'No visible vimbrowser DOM element at index ' + requestedIndex });
      const rect = target.getBoundingClientRect();
      clientX = Math.round(rect.left + rect.width / 2);
      clientY = Math.round(rect.top + rect.height / 2);
    } else {
      clientX = Math.round(requestedWindowX - chromeLeft);
      clientY = Math.round(requestedWindowY - chromeTop);
      target = closestClickable(document.elementFromPoint(clientX, clientY));
      if (!target) return JSON.stringify({ ok: false, error: 'No DOM element at content point ' + clientX + ',' + clientY, clientX, clientY, chromeLeft, chromeTop });
    }
    const hrefEl = target.closest && target.closest('a[href]');
    const href = hrefEl ? hrefEl.href : '';
    const before = location.href;
    try { target.focus && target.focus({ preventScroll: true }); } catch {}
    const eventInit = { bubbles: true, cancelable: true, view: window, clientX, clientY, screenX: clientX, screenY: clientY, button: 0, buttons: 1 };
    for (const type of ['pointerover','pointerenter','mouseover','mouseenter','pointermove','mousemove','pointerdown','mousedown','pointerup','mouseup','click']) {
      const ev = type.startsWith('pointer') && typeof PointerEvent !== 'undefined' ? new PointerEvent(type, eventInit) : new MouseEvent(type, eventInit);
      target.dispatchEvent(ev);
    }
    try { target.click && target.click(); } catch {}
    if (href && location.href === before) {
      try { hrefEl.click(); } catch {}
    }
    if (href && location.href === before) {
      location.href = href;
    }
    return JSON.stringify({ ok: true, tag: target.tagName.toLowerCase(), href, before, after: location.href, clientX, clientY, chromeLeft, chromeTop, text: (target.innerText || target.textContent || target.getAttribute('aria-label') || '').replace(/\s+/g, ' ').slice(0, 160) });
  })()`;
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

function renderVimbrowserDomState(dom: VimbrowserDomState): string[] {
  const m = dom.metrics;
  const lines = [
    "",
    "  browser: vimbrowser IPC",
    `  browserUrl: ${m.url}`,
    `  browserTitle: ${m.title}`,
    `  browserViewport: inner=${m.innerWidth}×${m.innerHeight} outer=${m.outerWidth}×${m.outerHeight} chromeLeft=${m.chromeLeft} chromeTop=${m.chromeTop} chromeBottom=${m.chromeBottom} scroll=${m.scrollX},${m.scrollY}`,
    "  domElements:",
  ];
  if (dom.elements.length === 0) {
    lines.push("    (no visible clickable/editable DOM elements found)");
    return lines;
  }
  for (const el of dom.elements) {
    const role = el.role ? ` role=${JSON.stringify(el.role)}` : "";
    const type = el.type ? ` type=${JSON.stringify(el.type)}` : "";
    const href = el.href ? ` href=${JSON.stringify(el.href)}` : "";
    const name = el.name ? ` ${JSON.stringify(el.name)}` : "";
    lines.push(`    ${el.index} ${el.tag}${role}${type}${name} windowRect=x=${el.windowRect.x} y=${el.windowRect.y} w=${el.windowRect.w} h=${el.windowRect.h}${href}`);
  }
  return lines;
}

function renderAppState(client: DwmClient, monitors: DwmMonitor[], screenshotNote: string | null, extraStateLines: string[] = []): string {
  const g = client.geometry;
  const monitor = monitors.find((m) => m.num === client.monitor);
  const lines = [
    "Computer Use state",
    "Backend: dwm IPC + direct X11 synthetic events (AT-SPI accessibility is pending)",
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
    isVimbrowserClient(client)
      ? "  accessibility: vimbrowser DOM elements are exposed above for element_index clicks; native AT-SPI is still pending"
      : "  accessibility: not wired yet (element_index/set_value/secondary actions unavailable until AT-SPI backend lands)",
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
  const maxElements = Math.max(1, Math.min(2000, Math.round(getNumber(input, "max_elements") ?? 300)));

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
    if (isVimbrowserClient(resolved.client)) {
      try {
        const dom = await getVimbrowserDomState(maxElements, signal);
        extraStateLines.push(...renderVimbrowserDomState(dom));
      } catch (err) {
        extraStateLines.push(`  browser: vimbrowser IPC unavailable/error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

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
  const mode = isVimbrowserClient(client)
    ? "Input mode: vimbrowser browser IPC/DOM action when available, otherwise direct X11 fallback; dwm focus/tag was not changed by Exocortex."
    : "Input mode: direct synthetic X11 events sent to the target window; dwm focus/tag was not changed by Exocortex.";
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

async function executeVimbrowserClick(client: DwmClient, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const elementIndex = parseElementIndex(getString(input, "element_index"));
  const x = numericInput(input, "x");
  const y = numericInput(input, "y");
  if (elementIndex == null && (x == null || y == null)) {
    return { output: "vimbrowser click requires either element_index from computer_get_app_state or window-relative x and y coordinates.", isError: true };
  }
  const result = await vimbrowserEvalJson<{ ok: boolean; error?: string; href?: string; before?: string; after?: string; tag?: string; text?: string; clientX?: number; clientY?: number; chromeLeft?: number }>(
    vimbrowserClickScript({ x: x ?? undefined, y: y ?? undefined, elementIndex: elementIndex ?? undefined }),
    signal,
  );
  if (!result.ok) return { output: result.error || "vimbrowser DOM click failed", isError: true };
  const target = elementIndex != null ? `element_index=${elementIndex}` : `window coordinates ${x},${y}`;
  const details = [`vimbrowser DOM click sent to ${target}.`];
  if (result.href) details.push(`href: ${result.href}`);
  if (result.before && result.after && result.before !== result.after) details.push(`navigation: ${result.before} → ${result.after}`);
  else if (result.after) details.push(`url: ${result.after}`);
  if (result.text) details.push(`target: ${result.tag ?? "element"} ${JSON.stringify(result.text)}`);
  await sleep(result.href ? 900 : 250);
  return actionState(details.join("\n"), client, signal);
}

async function executeVimbrowserScroll(client: DwmClient, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const direction = getString(input, "direction");
  if (!direction || !["up", "down", "left", "right"].includes(direction)) {
    return { output: "computer_scroll requires direction: up, down, left, or right.", isError: true };
  }
  const pages = Math.max(1, Math.min(20, numericInput(input, "pages") ?? 1));
  const dy = direction === "up" ? -850 : direction === "down" ? 850 : 0;
  if (direction === "left" || direction === "right") {
    const dx = direction === "left" ? -850 * pages : 850 * pages;
    await vimbrowserEvalJson<{ ok: boolean }>(`(() => { window.scrollBy(${dx}, 0); return JSON.stringify({ok:true, scrollX, scrollY}); })()`, signal);
  } else {
    const tab = await vimbrowserActiveTab(signal);
    await runVimbrowserCli(["scroll-tab", tab, String(dy), String(pages)], signal);
  }
  return actionState(`vimbrowser background scroll ${direction} x${pages} sent through browser IPC.`, client, signal);
}

function vimbrowserTypeScript(text: string): string {
  return `(() => {
    const text = ${JSON.stringify(text)};
    const el = document.activeElement;
    if (!el) return JSON.stringify({ok:false,error:'No active element'});
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    const editable = tag === 'textarea' || tag === 'input' || el.isContentEditable;
    if (!editable) return JSON.stringify({ok:false,error:'Active element is not editable', tag, text:(el.innerText||el.textContent||'').slice(0,80)});
    el.focus();
    if (el.isContentEditable) {
      document.execCommand('insertText', false, text);
    } else {
      const start = el.selectionStart ?? String(el.value || '').length;
      const end = el.selectionEnd ?? start;
      const before = String(el.value || '').slice(0, start);
      const after = String(el.value || '').slice(end);
      el.value = before + text + after;
      const pos = start + text.length;
      try { el.setSelectionRange(pos, pos); } catch {}
      el.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:text}));
      el.dispatchEvent(new Event('change', {bubbles:true}));
    }
    return JSON.stringify({ok:true, tag});
  })()`;
}

async function executeVimbrowserTypeText(client: DwmClient, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const text = typeof input.text === "string" ? input.text : null;
  if (text == null) return { output: "computer_type_text requires text.", isError: true };
  const result = await vimbrowserEvalJson<{ ok: boolean; error?: string; tag?: string }>(vimbrowserTypeScript(text), signal);
  if (!result.ok) {
    // Fall back to direct X11 events. This still avoids dwm focus/tag changes,
    // but browser widgets may ignore it.
    await runX11Helper(["type", client.win, text], signal);
    return actionState(`vimbrowser active DOM element was not editable (${result.error}); fell back to background X11 typing.`, client, signal);
  }
  return actionState(`vimbrowser DOM text insertion sent to active ${result.tag ?? "element"} (${text.length} chars).`, client, signal);
}

function vimbrowserSetValueScript(elementIndex: number, value: string): string {
  return `(() => {
    const requestedIndex = ${elementIndex};
    const value = ${JSON.stringify(value)};
    const selector = ['a[href]', 'button', 'input', 'textarea', 'select', 'summary', 'video', 'audio', '[contenteditable="true"]', '[role="button"]', '[role="link"]', '[role="menuitem"]', '[onclick]', 'ytd-thumbnail', 'yt-lockup-view-model', 'yt-button-shape', 'tp-yt-paper-button'].join(',');
    const closestTarget = (el) => el && (el.closest('a[href],button,input,textarea,select,summary,video,audio,[contenteditable="true"],[role="button"],[role="link"],[role="menuitem"],[onclick]') || el);
    const visible = (el, rect) => {
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0 && rect.left <= innerWidth && rect.top <= innerHeight;
    };
    const collect = () => {
      const out = [], seen = new Set();
      for (const el of Array.from(document.querySelectorAll(selector))) {
        const target = closestTarget(el);
        if (!target || seen.has(target)) continue;
        seen.add(target);
        const rect = target.getBoundingClientRect();
        if (!visible(target, rect)) continue;
        out.push(target);
      }
      return out;
    };
    const el = collect()[requestedIndex - 1];
    if (!el) return JSON.stringify({ok:false,error:'No visible vimbrowser DOM element at index ' + requestedIndex});
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    const editable = tag === 'textarea' || tag === 'input' || el.isContentEditable;
    if (!editable) return JSON.stringify({ok:false,error:'Element is not editable', tag, text:(el.innerText||el.textContent||'').replace(/\s+/g,' ').slice(0,100)});
    try { el.focus({preventScroll:true}); } catch { try { el.focus(); } catch {} }
    if (el.isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:value}));
      el.dispatchEvent(new Event('change', {bubbles:true}));
    } else {
      el.value = value;
      try { el.setSelectionRange(value.length, value.length); } catch {}
      el.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertReplacementText', data:value}));
      el.dispatchEvent(new Event('change', {bubbles:true}));
    }
    return JSON.stringify({ok:true, tag});
  })()`;
}

function vimbrowserKeyScript(key: string): string {
  return `(() => {
    const raw = ${JSON.stringify(key)};
    const parts = raw.split('+').map(s => s.trim()).filter(Boolean);
    let key = parts.pop() || raw;
    const mods = new Set(parts.map(s => s.toLowerCase()));
    const aliases = { Enter:'Enter', Return:'Enter', Esc:'Escape', Escape:'Escape', Space:' ', Tab:'Tab', Backspace:'Backspace', Delete:'Delete', Del:'Delete', Left:'ArrowLeft', Right:'ArrowRight', Up:'ArrowUp', Down:'ArrowDown', PageUp:'PageUp', PageDown:'PageDown' };
    key = aliases[key] || aliases[key[0]?.toUpperCase() + key.slice(1)] || key;
    if (key.length === 1 && (mods.has('ctrl') || mods.has('control') || mods.has('alt') || mods.has('meta') || mods.has('cmd') || mods.has('command'))) key = key.toLowerCase();
    const target = document.activeElement || document.body || document.documentElement;
    const init = { key, bubbles:true, cancelable:true, ctrlKey:mods.has('ctrl')||mods.has('control'), shiftKey:mods.has('shift'), altKey:mods.has('alt')||mods.has('option'), metaKey:mods.has('meta')||mods.has('cmd')||mods.has('command') };
    const down = new KeyboardEvent('keydown', init);
    target.dispatchEvent(down);
    if (key.length === 1) target.dispatchEvent(new KeyboardEvent('keypress', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
    const tag = target.tagName ? target.tagName.toLowerCase() : '';
    if (key === 'Enter' && !down.defaultPrevented && (tag === 'input' || tag === 'textarea')) {
      const form = target.form || target.closest?.('form');
      if (form) {
        try { form.requestSubmit ? form.requestSubmit() : form.submit(); } catch {}
      }
    }
    if (key === 'Escape' && target.blur) target.blur();
    return JSON.stringify({ok:true, key, tag});
  })()`;
}

async function executeVimbrowserPressKey(client: DwmClient, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const key = getString(input, "key");
  if (!key) return { output: "computer_press_key requires key.", isError: true };
  try {
    const result = await vimbrowserEvalJson<{ ok: boolean; error?: string; key?: string; tag?: string }>(vimbrowserKeyScript(key), signal);
    if (!result.ok) throw new Error(result.error || "vimbrowser key dispatch failed");
    return actionState(`vimbrowser DOM key ${JSON.stringify(key)} sent to active ${result.tag ?? "element"}.`, client, signal);
  } catch (err) {
    await runX11Helper(["key", client.win, key], signal);
    return actionState(`vimbrowser DOM key dispatch failed (${err instanceof Error ? err.message : String(err)}); fell back to background X11 key ${JSON.stringify(key)}.`, client, signal);
  }
}

export async function executeComputerSetValue(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const resolved = await resolveActionTarget(input, signal);
  if (isToolResult(resolved)) return resolved;
  const elementIndex = parseElementIndex(getString(input, "element_index"));
  const value = typeof input.value === "string" ? input.value : null;
  if (elementIndex == null) return { output: "computer_set_value requires a numeric element_index from computer_get_app_state.", isError: true };
  if (value == null) return { output: "computer_set_value requires value.", isError: true };
  if (!isVimbrowserClient(resolved.client)) {
    return { output: "computer_set_value currently requires the vimbrowser DOM backend; generic AT-SPI set_value is pending.", isError: true };
  }
  try {
    const result = await vimbrowserEvalJson<{ ok: boolean; error?: string; tag?: string; text?: string }>(vimbrowserSetValueScript(elementIndex, value), signal);
    if (!result.ok) return { output: result.error || "vimbrowser set_value failed", isError: true };
    return actionState(`vimbrowser DOM value set on element_index=${elementIndex} (${result.tag ?? "element"}, ${value.length} chars).`, resolved.client, signal);
  } catch (err) {
    return { output: err instanceof Error ? err.message : String(err), isError: true };
  }
}

export async function executeComputerPerformSecondaryAction(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const resolved = await resolveActionTarget(input, signal);
  if (isToolResult(resolved)) return resolved;
  const action = normalize(getString(input, "action"));
  const elementIndex = parseElementIndex(getString(input, "element_index"));
  if (!action) return { output: "computer_perform_secondary_action requires action.", isError: true };
  if (elementIndex == null) return { output: "computer_perform_secondary_action requires a numeric element_index from computer_get_app_state.", isError: true };
  if (!isVimbrowserClient(resolved.client)) {
    return { output: "computer_perform_secondary_action currently requires the vimbrowser DOM backend; generic AT-SPI actions are pending.", isError: true };
  }
  if (["press", "click", "open", "activate"].includes(action)) {
    return executeVimbrowserClick(resolved.client, { ...input, element_index: String(elementIndex) }, signal);
  }
  if (["focus", "raise"].includes(action)) {
    const result = await vimbrowserEvalJson<{ ok: boolean; error?: string }>(`(() => { const els = Array.from(document.querySelectorAll('a[href],button,input,textarea,select,[contenteditable="true"],[role="button"],[role="link"]')); const el = els[${elementIndex - 1}]; if (!el) return JSON.stringify({ok:false,error:'No element'}); el.focus && el.focus({preventScroll:true}); return JSON.stringify({ok:true}); })()`, signal);
    if (!result.ok) return { output: result.error || "vimbrowser focus action failed", isError: true };
    return actionState(`vimbrowser DOM focus action performed on element_index=${elementIndex}.`, resolved.client, signal);
  }
  return { output: `Unsupported vimbrowser secondary action ${JSON.stringify(action)}. Supported: press, click, open, activate, focus.`, isError: true };
}

export async function executeComputerClick(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const resolved = await resolveActionTarget(input, signal);
  if (isToolResult(resolved)) return resolved;

  if (isVimbrowserClient(resolved.client)) {
    try {
      return await executeVimbrowserClick(resolved.client, input, signal);
    } catch (err) {
      return { output: err instanceof Error ? err.message : String(err), isError: true };
    }
  }

  if (getString(input, "element_index") && (numericInput(input, "x") == null || numericInput(input, "y") == null)) {
    return { output: "element_index clicks require the upcoming AT-SPI backend. For now provide window-relative x and y coordinates.", isError: true };
  }

  const x = numericInput(input, "x");
  const y = numericInput(input, "y");
  if (x == null || y == null) {
    return { output: "computer_click currently requires window-relative x and y coordinates because AT-SPI element targeting is not wired yet.", isError: true };
  }

  const button = getString(input, "mouse_button") ?? "left";
  const count = Math.max(1, Math.min(3, numericInput(input, "click_count") ?? 1));
  try {
    await runX11Helper(["click", resolved.client.win, String(x), String(y), button, String(count)], signal);
    return actionState(`Background click sent to ${resolved.client.win} at ${x},${y} (${button}, count=${count}).`, resolved.client, signal);
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
    if (isVimbrowserClient(resolved.client)) return await executeVimbrowserTypeText(resolved.client, input, signal);
    await runX11Helper(["type", resolved.client.win, text], signal);
    return actionState(`Background text typing sent to ${resolved.client.win} (${text.length} chars).`, resolved.client, signal);
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
    if (isVimbrowserClient(resolved.client)) return await executeVimbrowserPressKey(resolved.client, input, signal);
    await runX11Helper(["key", resolved.client.win, key], signal);
    return actionState(`Background key ${JSON.stringify(key)} sent to ${resolved.client.win}.`, resolved.client, signal);
  } catch (err) {
    return { output: err instanceof Error ? err.message : String(err), isError: true };
  }
}

export async function executeComputerScroll(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const resolved = await resolveActionTarget(input, signal);
  if (isToolResult(resolved)) return resolved;
  if (isVimbrowserClient(resolved.client)) {
    try {
      return await executeVimbrowserScroll(resolved.client, input, signal);
    } catch (err) {
      return { output: err instanceof Error ? err.message : String(err), isError: true };
    }
  }
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
    return actionState(`Background scroll ${direction} x${pages} sent to ${resolved.client.win}.`, resolved.client, signal);
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
