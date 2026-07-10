import { existsSync, statSync } from "fs";
import { execFileSync } from "child_process";
import { homedir } from "os";
import { resolve } from "path";
import { readExocortexConfig, updateExocortexConfig, type ExocortexConfig, type PingMode } from "@exocortex/shared/config";
import { log } from "./log";
import { SUBAGENTS_FOLDER_NAME, type ConversationSummary, type FolderSummary } from "./messages";
import type { StreamingStopReason } from "./protocol";

type SpawnedProcess = { exited?: Promise<number>; unref?: () => void; kill?: () => void };
type SpawnFn = (command: string[], options?: { detached?: boolean }) => SpawnedProcess;
type BellFn = () => void;
type ActiveWindowReader = () => string | null;

const DEFAULT_SPAWN: SpawnFn = (command, options) => Bun.spawn(command, {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
  detached: options?.detached,
});

export function streamFinishedSoundCommand(path: string): string[] {
  return [
    "bash",
    "-lc",
    [
      "ffmpeg -v error -nostdin -i \"$1\"",
      "-f s16le -acodec pcm_s16le -ac 2 -ar 44100 -",
      "|",
      "aplay -q -t raw -f S16_LE -c 2 -r 44100 -",
    ].join(" "),
    "exocortex-ping-sound",
    path,
  ];
}

export type StreamFinishedPingMode = PingMode;

export interface StreamFinishedPingConfig {
  mode: StreamFinishedPingMode | null;
  sound: string | null;
}

function stripMatchingQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

function isPingMode(value: unknown): value is StreamFinishedPingMode {
  return value === "sound" || value === "notif" || value === "both";
}

function normalizeConfig(config: ExocortexConfig): StreamFinishedPingConfig {
  const ping = config.ping;
  if (ping && typeof ping === "object" && !Array.isArray(ping)) {
    const rawMode: unknown = ping.mode;
    const mode = rawMode === "notification" ? "notif" : (isPingMode(rawMode) ? rawMode : null);
    const sound = typeof ping.sound === "string" && ping.sound.trim() !== "" ? ping.sound : null;
    return { mode, sound };
  }

  // Compatibility for configs written by the short-lived /sound command.
  const legacySound = config.sound;
  if (typeof legacySound === "string" && legacySound.trim() !== "") {
    return { mode: "sound", sound: legacySound };
  }

  return { mode: null, sound: null };
}

export function normalizeSoundPath(input: string): string {
  const trimmed = stripMatchingQuotes(input.trim());
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

export function isUsableSoundFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

export function loadStreamFinishedPing(): StreamFinishedPingConfig {
  return normalizeConfig(readExocortexConfig());
}

export function saveStreamFinishedPing(mode: StreamFinishedPingMode, sound?: string | null): void {
  updateExocortexConfig((config) => {
    const current = normalizeConfig(config);
    config.ping = {
      mode,
      sound: sound !== undefined ? sound : current.sound,
    };
    delete config.sound;
  });
}

export function clearStreamFinishedPing(): void {
  updateExocortexConfig((config) => {
    config.ping = { mode: null, sound: null };
    delete config.sound;
  });
}

export async function playSoundFile(path: string, spawn: SpawnFn = DEFAULT_SPAWN): Promise<void> {
  if (!isUsableSoundFile(path)) {
    log("warn", `tui: configured stream-finished ping sound is not a file: ${path}`);
    return;
  }

  const command = streamFinishedSoundCommand(path);
  let child: SpawnedProcess;
  try {
    // The sound pipeline is isolated into a new session/process group so it
    // cannot inherit or perturb the TUI terminal/session. We still observe its
    // exit promise so a failed player cannot become an unhandled rejection, but
    // playback is not allowed to keep the UI process alive.
    child = spawn(command, { detached: true });
    child.unref?.();
  } catch (err) {
    log("warn", `tui: failed to spawn stream-finished ping sound pipeline: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  child.exited?.then((exitCode) => {
    if (exitCode !== 0) {
      log("warn", `tui: stream-finished ping sound pipeline exited with code ${exitCode}`);
    }
  }).catch((err) => {
    log("warn", `tui: stream-finished ping sound pipeline wait failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

let pendingBell = false;
let bellTimer: Timer | null = null;

function defaultBell(): void {
  process.stdout.write("\x07");
}

export function sendStreamFinishedNotification(bell: BellFn = defaultBell): void {
  if (pendingBell) return;
  pendingBell = true;
  bellTimer = setTimeout(() => {
    pendingBell = false;
    bellTimer = null;
    bell();
  }, 25);
}

export function cancelPendingStreamFinishedNotification(): void {
  if (bellTimer) clearTimeout(bellTimer);
  bellTimer = null;
  pendingBell = false;
}

function parseWindowId(value: string | null | undefined): bigint | null {
  if (!value) return null;
  const trimmed = value.trim();
  const match = trimmed.match(/0x[0-9a-f]+|\d+/i);
  if (!match) return null;
  try {
    return BigInt(match[0]);
  } catch {
    return null;
  }
}

export function readActiveWindowId(): string | null {
  if (!process.env.DISPLAY) return null;
  try {
    return execFileSync("xprop", ["-root", "_NET_ACTIVE_WINDOW"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 250,
    });
  } catch {
    return null;
  }
}

export interface StreamFinishedPingContext {
  completedConvId?: string | null;
  activeConvId?: string | null;
  isCompletedConvStreaming?: boolean;
  windowId?: string | null;
  activeWindowReader?: ActiveWindowReader;
}

export function isTerminalWindowFocused(
  windowId = process.env.WINDOWID,
  activeWindowReader: ActiveWindowReader = readActiveWindowId,
): boolean {
  const ownWindowId = parseWindowId(windowId);
  if (ownWindowId === null) return false;
  const activeWindowId = parseWindowId(activeWindowReader());
  return activeWindowId !== null && activeWindowId === ownWindowId;
}

export function shouldSuppressStreamFinishedPing(context: StreamFinishedPingContext): boolean {
  if (context.isCompletedConvStreaming) return true;

  return !!context.completedConvId
    && !!context.activeConvId
    && context.completedConvId === context.activeConvId
    && isTerminalWindowFocused(context.windowId ?? undefined, context.activeWindowReader ?? readActiveWindowId);
}

export interface BackgroundStreamCompletionUpdate {
  updatedConvId: string;
  wasStreaming: boolean;
  isStreaming: boolean;
  activeConvIdBeforeUpdate?: string | null;
  streamStopReason?: StreamingStopReason;
}

type PingConversationLocation = Pick<ConversationSummary, "id" | "folderId">;
type PingFolderLocation = Pick<FolderSummary, "id" | "name" | "parentId">;

/** True for conversations directly or transitively inside top-level subagents/. */
export function isConversationInSubagentsFolder(
  convId: string,
  conversations: readonly PingConversationLocation[],
  folders: readonly PingFolderLocation[],
): boolean {
  let folderId = conversations.find(conversation => conversation.id === convId)?.folderId ?? null;
  const visited = new Set<string>();
  while (folderId && !visited.has(folderId)) {
    visited.add(folderId);
    const folder = folders.find(candidate => candidate.id === folderId);
    if (!folder) return false;
    if ((folder.parentId ?? null) === null) {
      return folder.name.trim().toLocaleLowerCase() === SUBAGENTS_FOLDER_NAME;
    }
    folderId = folder.parentId;
  }
  return false;
}

export function shouldPingForBackgroundStreamCompletion(update: BackgroundStreamCompletionUpdate): boolean {
  return update.streamStopReason !== "daemon-restart"
    && update.wasStreaming
    && !update.isStreaming
    && update.updatedConvId !== update.activeConvIdBeforeUpdate;
}

export function shouldPingForStreamStopped(reason?: StreamingStopReason): boolean {
  return reason !== "daemon-restart";
}

export function runStreamFinishedPing(context: StreamFinishedPingContext = {}): void {
  if (shouldSuppressStreamFinishedPing(context)) return;

  let ping: StreamFinishedPingConfig;
  try {
    ping = loadStreamFinishedPing();
  } catch (err) {
    log("warn", `tui: failed to load stream-finished ping config: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!ping.mode) return;

  if (ping.mode === "notif" || ping.mode === "both") {
    try {
      sendStreamFinishedNotification();
    } catch (err) {
      log("warn", `tui: stream-finished ping notif failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if ((ping.mode === "sound" || ping.mode === "both") && ping.sound) {
    void playSoundFile(ping.sound).catch((err) => {
      log("warn", `tui: stream-finished ping sound failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}
