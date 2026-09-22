/** Remote paths are resolved by the selected daemon, never by the TUI host. */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { runtimeDir } from "@exocortex/shared/paths";
import type { Event, FileLinkResolvedEvent } from "./protocol";
import { isWebUrl, localPathFromTarget } from "./links";
import { openConversationTarget, openTargetDetached } from "./openable";
import { validateSshAlias } from "./ssh-transport";

const MAX_FILE_BYTES = 128 * 1024 * 1024;
const PREVIEW_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export function remoteDirectoryUrl(alias: string, path: string): string {
  if (validateSshAlias(alias) || !validRemotePath(path)) throw new Error("Invalid remote folder.");
  return `sftp://${alias}${path.split("/").map(encodeURIComponent).join("/")}`;
}

function validRemotePath(path: unknown): path is string {
  return typeof path === "string" && path.startsWith("/") && !/[\u0000-\u001f\u007f-\u009f]/u.test(path);
}

/** Force SFTP: remote filenames must never be interpreted by a remote shell. */
export function remoteFileCopyArgs(alias: string, path: string, destination: string): string[] {
  if (validateSshAlias(alias) || !validRemotePath(path)) throw new Error("Invalid remote file.");
  // scp's SFTP source supports globs; quote those metacharacters for an exact file.
  const literalPath = path.replace(/[\\*?[\]]/g, "\\$&");
  return [
    "-s", "-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
    "-o", "ControlPath=none", "--", `${alias}:${literalPath}`, destination,
  ];
}

interface DownloadedFile {
  path: string;
  discard(): Promise<void>;
}

async function downloadRemoteFile(alias: string, path: string, signal: AbortSignal): Promise<DownloadedFile> {
  const root = join(runtimeDir(), "file-link-previews");
  await mkdir(root, { recursive: true, mode: 0o700 });
  // Retain previews after the TUI exits: detached viewers may still need them.
  // Remove only our expired preview directories, never source files.
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("preview-")) continue;
    const previous = join(root, entry.name);
    try {
      if (Date.now() - (await stat(previous)).mtimeMs > PREVIEW_LIFETIME_MS) {
        await rm(previous, { recursive: true, force: true });
      }
    } catch { /* Another TUI may be maintaining the same preview cache. */ }
  }
  const directory = await mkdtemp(join(root, "preview-"));
  const destination = join(directory, basename(path));
  const discard = () => rm(directory, { recursive: true, force: true });
  try {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const child = spawn("scp", remoteFileCopyArgs(alias, path, destination), {
        stdio: ["ignore", "ignore", "pipe"], signal, shell: false,
      });
      let stderr = "";
      child.stderr?.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
      child.once("error", reject);
      child.once("close", code => {
        if (code === 0) resolve();
        else reject(new Error(`SFTP download failed (${code}): ${stderr.trim()}`));
      });
    });
    signal.throwIfAborted();
    const info = await stat(destination);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error("Remote preview exceeds the 128 MiB limit.");
    return { path: destination, discard };
  } catch (error) {
    await discard();
    throw error;
  }
}

function openRemoteDirectory(alias: string, path: string): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn("xdg-open", [remoteDirectoryUrl(alias, path)], { detached: true, stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", code => resolve(code === 0));
    child.unref();
  });
}

export interface FileLinkContext {
  alias: string | null;
  conversationId: string | null;
}

interface FileLinkDependencies {
  context(): FileLinkContext;
  request(conversationId: string, target: string): string | null;
  notify(message: string): void;
  openLocal?: typeof openConversationTarget;
  download?: typeof downloadRemoteFile;
  openFile?: (path: string) => boolean;
  openDirectory?: (alias: string, path: string) => boolean | Promise<boolean>;
}

interface PendingLink {
  context: FileLinkContext;
  abort: AbortController;
  timer: ReturnType<typeof setTimeout>;
  downloading: boolean;
}

export class RemoteFileLinkController {
  private pending = new Map<string, PendingLink>();
  constructor(private readonly dependencies: FileLinkDependencies) {}

  open(target: string): void {
    const context = this.dependencies.context();
    if (!context.alias || isWebUrl(target)) {
      // Web links always open on the TUI host, even over /ssh.
      (this.dependencies.openLocal ?? openConversationTarget)(target, isWebUrl(target) ? null : context.conversationId);
      return;
    }
    if (localPathFromTarget(target) === null) return;
    if (!context.conversationId) {
      this.dependencies.notify("Open a remote conversation before opening a file link.");
      return;
    }
    if (this.pending.size >= 8) {
      this.dependencies.notify("Too many remote file links are already opening.");
      return;
    }
    const reqId = this.dependencies.request(context.conversationId, target);
    if (!reqId) {
      this.dependencies.notify("Remote file link unavailable: the SSH daemon is disconnected.");
      return;
    }
    const pending: PendingLink = {
      context, abort: new AbortController(), downloading: false,
      timer: setTimeout(() => this.expire(reqId), 15_000),
    };
    this.pending.set(reqId, pending);
  }

  /** Cancel on disconnect, route switch, or TUI shutdown. Never replay opens. */
  cancel(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.abort.abort();
    }
    this.pending.clear();
  }

  handleEvent(event: Event): boolean {
    if (event.type !== "file_link_resolved" && event.type !== "error") return false;
    if (typeof event.reqId !== "string" || !event.reqId.startsWith("file_link_")) return false;
    const pending = this.pending.get(event.reqId);
    if (!pending || pending.downloading) return true;
    if (!this.isCurrent(pending)) { this.finish(event.reqId); return true; }
    if (event.type === "error") {
      this.dependencies.notify(`Remote file link failed: ${event.message}`);
      this.finish(event.reqId);
      return true;
    }
    if (event.convId !== pending.context.conversationId || !validRemotePath(event.path)) {
      this.dependencies.notify("Remote daemon returned an invalid file link.");
      this.finish(event.reqId);
      return true;
    }
    pending.downloading = true;
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => this.expire(event.reqId), 120_000);
    void this.openResolved(event, pending);
    return true;
  }

  private isCurrent(pending: PendingLink): boolean {
    const current = this.dependencies.context();
    return !pending.abort.signal.aborted && current.alias === pending.context.alias
      && current.conversationId === pending.context.conversationId;
  }

  private finish(reqId: string): void {
    const pending = this.pending.get(reqId);
    if (pending) clearTimeout(pending.timer);
    this.pending.delete(reqId);
  }

  private expire(reqId: string): void {
    const pending = this.pending.get(reqId);
    if (!pending) return;
    if (this.isCurrent(pending)) this.dependencies.notify("Remote file link timed out. The remote daemon must support file links.");
    pending.abort.abort();
    this.finish(reqId);
  }

  private async openResolved(event: FileLinkResolvedEvent, pending: PendingLink): Promise<void> {
    try {
      if (event.kind === "directory") {
        const opened = await (this.dependencies.openDirectory ?? openRemoteDirectory)(pending.context.alias!, event.path);
        if (!opened) throw new Error("No local SFTP folder handler could be started.");
      } else {
        if (event.kind !== "file" || !Number.isFinite(event.size) || event.size < 0 || event.size > MAX_FILE_BYTES) {
          throw new Error("Remote preview exceeds the 128 MiB limit or is not a regular file.");
        }
        const file = await (this.dependencies.download ?? downloadRemoteFile)(
          pending.context.alias!, event.path, pending.abort.signal,
        );
        if (!this.isCurrent(pending)) { await file.discard(); return; }
        const opened = (this.dependencies.openFile ?? (path =>
          openTargetDetached(pathToFileURL(path).href, { localLink: true })))(file.path);
        if (!opened) { await file.discard(); throw new Error("No local viewer could be started."); }
      }
    } catch (error) {
      if (this.isCurrent(pending)) this.dependencies.notify(`Remote file link failed: ${error instanceof Error ? error.message : error}`);
    } finally { this.finish(event.reqId); }
  }
}
