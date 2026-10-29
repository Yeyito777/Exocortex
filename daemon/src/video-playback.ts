/**
 * Plays stored videos in a client's terminal (docs/video-attachments.md).
 *
 * Each playback is one `st-play --pipe` on this host: it transcodes the file
 * to H.264 + AAC, adapts the bitrate and resolution to the measured link and
 * keeps the bytes in flight small (st's docs/video.md). Its stdout goes to
 * the client as `video_output` (whole APCs only, so the client can write each
 * event between its own frames); the client relays its terminal's replies
 * back (`video_input`), which are the acknowledgements st-play's flow control
 * runs on, so it measures every link between here and the terminal: the
 * daemon socket, an SSH proxy, the client's PTY.
 */

import type { Subprocess } from "bun";
import type { ConnectedClient } from "./server";
import type { Event, VideoControlCommand, VideoPlayCommand } from "./protocol";
import { findStoredVideo, isImageId } from "./attachments";
import { log } from "./log";

/** st allows four open videos per terminal; one client rarely needs more than one. */
export const MAX_PLAYBACKS_PER_CLIENT = 2;
const MAX_PLAYBACKS = 8;
const MAX_INPUT_CHARS = 256 * 1024;
const STOP_GRACE_MS = 1_500;
const PLAYBACK_ID = /^[A-Za-z0-9_-]{1,64}$/;

const ESC = "\x1b";
const APC_START = `${ESC}_`;
const ST = `${ESC}\\`;

/**
 * Split st-play's output into whole APCs and the unfinished rest. A chunked
 * transfer (`m=1` until the last chunk) counts as one: nothing may come
 * between its chunks in the terminal. Bytes outside an APC (there should be
 * none) are dropped rather than passed to someone's terminal.
 */
export function takeCompleteApcs(buffer: string): { complete: string; rest: string } {
  let complete = "";
  let group = "";
  let groupStart = -1;
  let restStart = -1;
  let position = 0;
  for (;;) {
    const start = buffer.indexOf(APC_START, position);
    if (start === -1) break;
    const end = buffer.indexOf(ST, start + 2);
    if (end === -1) {
      restStart = start;
      break;
    }
    const apc = buffer.slice(start, end + 2);
    const body = apc.slice(2, -2);
    const separator = body.indexOf(";");
    const controls = (separator === -1 ? body : body.slice(0, separator)).replace(/^G/, "");
    if (groupStart === -1) groupStart = start;
    group += apc;
    position = end + 2;
    if (!controls.split(",").includes("m=1")) {
      complete += group;
      group = "";
      groupStart = -1;
    }
  }
  // An unfinished chunked transfer is sent again whole once it ends.
  if (groupStart !== -1) restStart = groupStart;
  // A trailing ESC may begin the next APC.
  else if (restStart === -1) restStart = buffer.endsWith(ESC) ? buffer.length - 1 : buffer.length;
  return { complete, rest: buffer.slice(restStart) };
}

/** The status line st-play --pipe prints once a second, as a video_status event. */
export function parseStatusLine(line: string, playbackId: string): Event | null {
  const match = /^status kbps=(\d+) size=(\d+)x(\d+) copy=([01]) rate=(\d+) rtt=([\d.]+)$/.exec(line.trim());
  if (!match) return null;
  return {
    type: "video_status",
    playbackId,
    kbps: Number(match[1]),
    width: Number(match[2]),
    height: Number(match[3]),
    copy: match[4] === "1",
    rateKbps: Number(match[5]),
    rttMs: Math.round(Number(match[6]) * 1000),
  };
}

/** The pipe command a video_control asks for, or null when it is malformed. */
export function controlCommand(command: Pick<VideoControlCommand, "action" | "value" | "width" | "height">): string | null {
  const value = command.value;
  const finite = typeof value === "number" && Number.isFinite(value);
  switch (command.action) {
    case "pause":
    case "resume":
    case "toggle":
      return command.action;
    case "seek":
      return finite && value >= 0 ? `seek ${value.toFixed(3)}` : null;
    case "skip":
      return finite && Math.abs(value) <= 86_400 ? `skip ${value.toFixed(3)}` : null;
    case "volume":
      return finite && value >= 0 && value <= 1 ? `volume ${value.toFixed(3)}` : null;
    case "mute":
      return value === 0 || value === 1 ? `mute ${value}` : null;
    case "size": {
      const { width, height } = command;
      return validSize(width) && validSize(height) ? `size ${width}x${height}` : null;
    }
    default:
      return null;
  }
}

function validSize(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 16_384;
}

function pipeCommand(text: string): string {
  return `${APC_START}!${text}${ST}`;
}

let stPlayChecked: { path: string | null; reason: string } | null = null;

/**
 * The st-play this host plays with: $EXOCORTEX_ST_PLAY or the one on PATH,
 * as long as it has --pipe (st after Oct 29 2026).
 */
export function stPlayPath(): { path: string | null; reason: string } {
  if (stPlayChecked) return stPlayChecked;
  const path = process.env.EXOCORTEX_ST_PLAY || Bun.which("st-play") || Bun.which("st-play", { PATH: "/usr/local/bin:/opt/homebrew/bin" });
  if (!path) {
    stPlayChecked = { path: null, reason: "video playback needs st-play (from st) on the daemon's host" };
    return stPlayChecked;
  }
  const help = Bun.spawnSync([path, "--help"], { stdout: "pipe", stderr: "pipe", timeout: 5_000 });
  stPlayChecked = help.stdout.toString().includes("--pipe")
    ? { path, reason: "" }
    : { path: null, reason: `${path} is too old to play in Exocortex (no --pipe): update st` };
  return stPlayChecked;
}

export const videoPlaybackInternalsForTest = {
  resetStPlay(): void { stPlayChecked = null; },
};

interface Playback {
  key: string;
  playbackId: string;
  client: ConnectedClient;
  proc: Subprocess<"pipe", "pipe", "pipe">;
  stopping: boolean;
  stderrTail: string[];
  lastStatus: string;
  killTimer: ReturnType<typeof setTimeout> | null;
}

export interface VideoPlaybackHost {
  sendTo(client: ConnectedClient, event: Event): void;
  onClientClosed?: (listener: (client: ConnectedClient) => void) => () => void;
}

export class VideoPlayback {
  private readonly playbacks = new Map<string, Playback>();
  private readonly stopClose: () => void;

  constructor(private readonly host: VideoPlaybackHost) {
    this.stopClose = host.onClientClosed?.(client => this.stopClient(client)) ?? (() => {});
  }

  private key(client: ConnectedClient, playbackId: string): string {
    return `${client.id}:${playbackId}`;
  }

  private ended(client: ConnectedClient, playbackId: string, reason: "stopped" | "error", message?: string): void {
    this.host.sendTo(client, { type: "video_ended", playbackId, reason, ...(message ? { message } : {}) });
  }

  play(client: ConnectedClient, command: VideoPlayCommand): void {
    const { playbackId } = command;
    if (typeof playbackId !== "string" || !PLAYBACK_ID.test(playbackId)) {
      this.host.sendTo(client, { type: "error", message: "video_play: invalid playbackId" });
      return;
    }
    const fail = (message: string) => this.ended(client, playbackId, "error", message);
    if (this.playbacks.has(this.key(client, playbackId))) return fail("that playback is already running");
    if (!isImageId(command.videoId)) return fail("invalid video id");
    if (!Number.isSafeInteger(command.kittyId) || command.kittyId < 1 || command.kittyId > 0xffffffff) return fail("invalid kittyId");
    if (!validSize(command.width) || !validSize(command.height)) return fail("invalid size");
    if (command.link !== "local" && command.link !== "remote") return fail("invalid link");
    if (command.startMs !== undefined && !(Number.isFinite(command.startMs) && command.startMs >= 0)) return fail("invalid start");
    if (command.volume !== undefined && !(Number.isFinite(command.volume) && command.volume >= 0 && command.volume <= 1)) return fail("invalid volume");
    const mine = [...this.playbacks.values()].filter(playback => playback.client === client).length;
    if (mine >= MAX_PLAYBACKS_PER_CLIENT || this.playbacks.size >= MAX_PLAYBACKS) return fail("too many videos are playing");
    const stored = findStoredVideo(command.videoId);
    if (!stored) return fail("video not found on the daemon's host");
    const player = stPlayPath();
    if (!player.path) return fail(player.reason);

    const args = [
      player.path, "--pipe", "--id", String(command.kittyId),
      "--size", `${command.width}x${command.height}`, "--link", command.link, "--copy",
      ...(command.startMs ? ["--start", (command.startMs / 1000).toFixed(3)] : []),
      ...(command.volume !== undefined ? ["--volume", command.volume.toFixed(3)] : []),
      stored.path,
    ];
    let proc: Subprocess<"pipe", "pipe", "pipe">;
    try {
      proc = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    } catch (error) {
      return fail(`could not start st-play: ${error instanceof Error ? error.message : String(error)}`);
    }
    const playback: Playback = {
      key: this.key(client, playbackId), playbackId, client, proc,
      stopping: false, stderrTail: [], lastStatus: "", killTimer: null,
    };
    this.playbacks.set(playback.key, playback);
    log("info", `video: ${client.id} playing ${command.videoId.slice(0, 12)} as ${playbackId} (${command.width}x${command.height}, ${command.link}, pid ${proc.pid})`);
    void this.pumpOutput(playback);
    void this.pumpStatus(playback);
    void proc.exited.then(code => this.exited(playback, code));
  }

  input(client: ConnectedClient, playbackId: string, data: unknown): void {
    const playback = this.playbacks.get(this.key(client, playbackId));
    if (!playback || playback.stopping || typeof data !== "string" || data.length === 0 || data.length > MAX_INPUT_CHARS) return;
    this.write(playback, data);
  }

  control(client: ConnectedClient, command: VideoControlCommand): void {
    const playback = this.playbacks.get(this.key(client, command.playbackId));
    if (!playback || playback.stopping) return;
    const text = controlCommand(command);
    if (!text) {
      this.host.sendTo(client, { type: "error", message: `video_control: invalid ${String(command.action)}` });
      return;
    }
    this.write(playback, pipeCommand(text));
  }

  stop(client: ConnectedClient, playbackId: string): void {
    const playback = this.playbacks.get(this.key(client, playbackId));
    if (playback) this.stopPlayback(playback, false);
  }

  /** Every playback of a client that went away. */
  stopClient(client: ConnectedClient): void {
    for (const playback of [...this.playbacks.values()]) {
      if (playback.client === client) this.stopPlayback(playback, true);
    }
  }

  /** Stop everything (daemon shutdown). */
  dispose(): void {
    this.stopClose();
    for (const playback of [...this.playbacks.values()]) this.stopPlayback(playback, true);
  }

  activeCount(): number {
    return this.playbacks.size;
  }

  private write(playback: Playback, data: string): void {
    try {
      playback.proc.stdin.write(data);
      void playback.proc.stdin.flush();
    } catch {
      // Exiting: its exit reports why.
    }
  }

  private stopPlayback(playback: Playback, now: boolean): void {
    if (playback.stopping && !now) return;
    playback.stopping = true;
    if (now) {
      playback.proc.kill("SIGTERM");
    } else {
      this.write(playback, pipeCommand("quit"));
      try { void playback.proc.stdin.end(); } catch { /* already closed */ }
    }
    playback.killTimer ??= setTimeout(() => {
      try { playback.proc.kill("SIGKILL"); } catch { /* gone */ }
    }, STOP_GRACE_MS);
    playback.killTimer.unref?.();
  }

  private async pumpOutput(playback: Playback): Promise<void> {
    const decoder = new TextDecoder();
    let pending = "";
    try {
      for await (const chunk of playback.proc.stdout) {
        pending += decoder.decode(chunk, { stream: true });
        const { complete, rest } = takeCompleteApcs(pending);
        pending = rest;
        if (complete && !playback.stopping) {
          this.host.sendTo(playback.client, { type: "video_output", playbackId: playback.playbackId, data: complete });
        }
      }
    } catch {
      // The process went away; exited() reports it.
    }
  }

  private async pumpStatus(playback: Playback): Promise<void> {
    const decoder = new TextDecoder();
    let pending = "";
    try {
      for await (const chunk of playback.proc.stderr) {
        pending += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          if (!line) continue;
          const status = parseStatusLine(line, playback.playbackId);
          if (!status) {
            playback.stderrTail = [...playback.stderrTail, line.replace(/^st-play: /, "")].slice(-3);
            continue;
          }
          const signature = JSON.stringify({ ...status, rateKbps: 0, rttMs: 0 });
          if (signature === playback.lastStatus || playback.stopping) continue;
          playback.lastStatus = signature;
          this.host.sendTo(playback.client, status);
        }
        if (pending.length > 4096) pending = pending.slice(-4096);
      }
    } catch {
      // As above.
    }
  }

  private exited(playback: Playback, code: number): void {
    if (playback.killTimer) clearTimeout(playback.killTimer);
    this.playbacks.delete(playback.key);
    const failed = !playback.stopping && code !== 0;
    const message = failed ? playback.stderrTail.at(-1) ?? `st-play exited with code ${code}` : undefined;
    if (failed) log("warn", `video: ${playback.playbackId} failed: ${message}`);
    this.ended(playback.client, playback.playbackId, failed ? "error" : "stopped", message);
  }
}
