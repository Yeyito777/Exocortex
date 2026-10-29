/**
 * Terminal image capability detection.
 *
 * Kitty graphics support cannot be inferred from TERM (the user's st fork
 * keeps `st-256color`), so the TUI asks: a graphics query (`a=q`) followed by
 * a DA1 request. Terminals answer DA1 in order, so a DA1 reply that arrives
 * before any graphics reply means "no Kitty graphics". `CSI 16 t` reports the
 * cell size in pixels, which image layout and preview sizing use. st's video
 * query (`a=v,k=c`, st docs/video.md) rides along before the DA1 the same way:
 * an `OK video=h264` answer means attached videos can play inline.
 */

const ESC = "\x1b";
const APC = `${ESC}_G`;
const ST = `${ESC}\\`;
/** Arbitrary id in our namespace; answered replies carry it back. */
export const GRAPHICS_QUERY_IMAGE_ID = 0x7ffffff0;
export const VIDEO_QUERY_IMAGE_ID = 0x7ffffff1;
/** 1×1 RGBA pixel: a query must carry decodable data. */
const QUERY_PAYLOAD = "AAAAAA==";
const DEFAULT_QUERY_TIMEOUT_MS = 3000;

export type TerminalImageMode = "pending" | "kitty" | "halfblock" | "off";
/** Whether the terminal plays st's H.264 + AAC video (`a=v`). */
export type TerminalVideoSupport = "pending" | "yes" | "no";

export function kittyGraphicsQuery(): string {
  return `${APC}a=q,t=d,f=32,s=1,v=1,i=${GRAPHICS_QUERY_IMAGE_ID};${QUERY_PAYLOAD}${ST}`;
}

export function videoCapabilityQuery(): string {
  return `${APC}a=v,i=${VIDEO_QUERY_IMAGE_ID},k=c${ST}`;
}

/** st answers `OK video=h264 audio=aac max=4096x4096`; anything else is no. */
export function videoCapabilityPlays(message: string): boolean {
  return /^OK\b/.test(message) && /(?:^|\s)video=(?:[\w,]*,)?h264\b/.test(message);
}

export const DA1_QUERY = `${ESC}[c`;
export const CELL_SIZE_QUERY = `${ESC}[16t`;

export function isDa1Response(sequence: string): boolean {
  return /^\x1b\[\?[\d;]*c$/.test(sequence);
}

export function isKittyGraphicsResponse(sequence: string): boolean {
  return sequence.startsWith(APC) && sequence.endsWith(ST);
}

/** Parse `CSI 6 ; height ; width t`. */
export function parseCellSizeResponse(sequence: string): { width: number; height: number } | null {
  const match = /^\x1b\[6;(\d+);(\d+)t$/.exec(sequence);
  if (!match) return null;
  const height = Number(match[1]);
  const width = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return null;
  if (width > 1000 || height > 1000) return null;
  return { width, height };
}

/** Parse a graphics reply into its id and message (`OK`, `ENOENT:...`). */
export function parseKittyGraphicsResponse(sequence: string): { imageId: number; placementId: number | null; message: string } | null {
  if (!isKittyGraphicsResponse(sequence)) return null;
  const body = sequence.slice(APC.length, -ST.length);
  const separator = body.indexOf(";");
  const controls = separator === -1 ? body : body.slice(0, separator);
  const message = separator === -1 ? "" : body.slice(separator + 1);
  let imageId = 0;
  let placementId: number | null = null;
  for (const field of controls.split(",")) {
    const [key, value] = field.split("=");
    if (key === "i") imageId = Number(value);
    else if (key === "p") placementId = Number(value);
  }
  if (!Number.isSafeInteger(imageId) || imageId <= 0) return null;
  return { imageId, placementId, message };
}

/** Explicit override for testing or broken terminals: EXOCORTEX_TUI_IMAGES=kitty|halfblock|off. */
export function forcedImageMode(env: NodeJS.ProcessEnv = process.env): TerminalImageMode | null {
  const value = env.EXOCORTEX_TUI_IMAGES?.trim().toLowerCase();
  return value === "kitty" || value === "halfblock" || value === "off" ? value : null;
}

/** EXOCORTEX_TUI_VIDEO=off keeps attached videos as posters (the query is not sent). */
export function videoDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EXOCORTEX_TUI_VIDEO?.trim().toLowerCase() === "off";
}

export interface TerminalGraphicsDetectorOptions {
  write: (sequence: string) => void;
  onModeChanged: (mode: TerminalImageMode) => void;
  onVideoChanged?: (support: TerminalVideoSupport) => void;
  queryTimeoutMs?: number;
}

export class TerminalGraphicsDetector {
  private mode: TerminalImageMode = "pending";
  private video: TerminalVideoSupport = "pending";
  private started = false;
  private timeout: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: TerminalGraphicsDetectorOptions) {}

  getMode(): TerminalImageMode {
    return this.mode;
  }

  getVideoSupport(): TerminalVideoSupport {
    return this.video;
  }

  /** Detect once; later calls do nothing. */
  start(env: NodeJS.ProcessEnv = process.env): void {
    if (this.started) return;
    this.started = true;
    const forced = forcedImageMode(env);
    // tmux neither forwards Kitty graphics nor keeps placements in its own
    // grid, and it shows an unknown APC string as the pane title.
    if (env.TMUX || (forced && forced !== "kitty")) {
      this.setMode(forced ?? "halfblock");
      this.setVideo("no");
      return;
    }
    if (forced) this.setMode(forced);
    const askVideo = !videoDisabled(env);
    if (!askVideo) this.setVideo("no");
    if (forced && !askVideo) return;
    this.options.write((forced ? "" : kittyGraphicsQuery()) + (askVideo ? videoCapabilityQuery() : "") + DA1_QUERY);
    this.timeout = setTimeout(() => {
      this.timeout = null;
      if (this.mode === "pending") this.setMode("halfblock");
      if (this.video === "pending") this.setVideo("no");
    }, this.options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS);
    this.timeout.unref?.();
  }

  /** Returns true when the sequence was a reply to the detection queries. */
  handleControlSequence(sequence: string): boolean {
    if (isDa1Response(sequence)) {
      if (this.mode === "pending") this.setMode("halfblock");
      if (this.video === "pending") this.setVideo("no");
      this.clearTimeout();
      return true;
    }
    const reply = parseKittyGraphicsResponse(sequence);
    if (reply?.imageId === GRAPHICS_QUERY_IMAGE_ID) {
      if (this.mode === "pending") this.setMode(reply.message === "OK" ? "kitty" : "halfblock");
      return true;
    }
    if (reply?.imageId === VIDEO_QUERY_IMAGE_ID) {
      if (this.video === "pending") this.setVideo(videoCapabilityPlays(reply.message) ? "yes" : "no");
      return true;
    }
    return false;
  }

  dispose(): void {
    this.clearTimeout();
  }

  private setMode(mode: TerminalImageMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.options.onModeChanged(mode);
  }

  private setVideo(support: TerminalVideoSupport): void {
    if (this.video === support) return;
    this.video = support;
    this.options.onVideoChanged?.(support);
  }

  private clearTimeout(): void {
    if (!this.timeout) return;
    clearTimeout(this.timeout);
    this.timeout = null;
  }
}
