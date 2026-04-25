import { closeSync, mkdirSync, openSync } from "fs";
import { spawn, type ChildProcess } from "child_process";
import { log } from "./log";
import {
  buildDaemonSpawnSpec,
  clearDaemonPidFile,
  getDaemonStatePaths,
  killProcessGroup,
  reapStaleManagedDaemonPid,
  writeDaemonPidFile,
} from "./external-tools-daemon-process";
import type { ExternalToolDaemonAction, ExternalToolDaemonStatus, LoadedTool, ManifestDaemon } from "./external-tools-types";

interface ManagedDaemon {
  toolName: string;
  toolDir: string;
  config: ManifestDaemon;
  child: ChildProcess | null;
  restartCount: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  lastStartTime: number;
  stopping: boolean;
  starting: boolean;
}

/** Restart backoff schedule (ms). Resets after 5 min of stable uptime. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const BACKOFF_RESET_MS = 5 * 60_000;

function daemonSignature(daemon: ManifestDaemon | undefined): string {
  return JSON.stringify(daemon ?? null);
}

function daemonConfigChanged(oldTool: LoadedTool, newTool: LoadedTool): boolean {
  return oldTool.toolDir !== newTool.toolDir || daemonSignature(oldTool.manifest.daemon) !== daemonSignature(newTool.manifest.daemon);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ExternalToolDaemonSupervisor {
  private readonly daemons = new Map<string, ManagedDaemon>();
  private tools: LoadedTool[] = [];

  get count(): number {
    return this.daemons.size;
  }

  setInitialTools(tools: LoadedTool[]): void {
    this.tools = tools;
  }

  startConfiguredDaemons(): void {
    for (const tool of this.tools) {
      if (tool.manifest.daemon) void this.startToolDaemon(tool);
    }
  }

  applyToolChanges(tools: LoadedTool[]): void {
    const oldByName = new Map(this.tools.map((tool) => [tool.manifest.name, tool]));
    const newByName = new Map(tools.map((tool) => [tool.manifest.name, tool]));

    // Stop daemons for removed tools or tools whose daemon config disappeared.
    for (const [name, oldTool] of oldByName) {
      const newTool = newByName.get(name);
      if (!newTool || (oldTool.manifest.daemon && !newTool.manifest.daemon)) {
        void this.stopToolDaemon(name);
      }
    }

    for (const [name, newTool] of newByName) {
      const oldTool = oldByName.get(name);
      if (!oldTool) {
        if (newTool.manifest.daemon) void this.startToolDaemon(newTool);
        continue;
      }

      if (!oldTool.manifest.daemon && newTool.manifest.daemon) {
        void this.startToolDaemon(newTool);
        continue;
      }

      if (oldTool.manifest.daemon && newTool.manifest.daemon && daemonConfigChanged(oldTool, newTool)) {
        void this.stopToolDaemon(name).then(() => this.startToolDaemon(newTool));
      }
    }

    this.tools = tools;
  }

  async manage(toolName: string, action: ExternalToolDaemonAction): Promise<ExternalToolDaemonStatus> {
    const tool = this.getToolByName(toolName);
    if (!tool) {
      throw new Error(`External tool '${toolName}' is not loaded`);
    }
    if (!tool.manifest.daemon) {
      throw new Error(`External tool '${toolName}' does not declare a supervised daemon`);
    }

    const before = this.daemons.get(toolName) ?? null;
    const wasRunning = Boolean(before?.child?.pid);

    switch (action) {
      case "status":
        return this.buildStatus(
          toolName,
          action,
          wasRunning
            ? `Supervised daemon '${toolName}' is running${before?.child?.pid ? ` (pid ${before.child.pid})` : ""}`
            : `Supervised daemon '${toolName}' is not running`,
          tool,
        );

      case "start":
        await this.startToolDaemon(tool);
        await this.waitForDaemonStateToSettle(toolName);
        if (wasRunning) {
          return this.buildStatus(toolName, action, `Supervised daemon '${toolName}' is already running`, tool);
        }
        return this.buildStatus(
          toolName,
          action,
          this.daemons.get(toolName)?.child?.pid
            ? `Started supervised daemon '${toolName}' (pid ${this.daemons.get(toolName)?.child?.pid})`
            : `Requested start for supervised daemon '${toolName}'`,
          tool,
        );

      case "stop":
        if (!this.daemons.has(toolName)) {
          return this.buildStatus(toolName, action, `Supervised daemon '${toolName}' is already stopped`, tool);
        }
        await this.stopToolDaemon(toolName);
        await this.waitForDaemonStateToSettle(toolName);
        return this.buildStatus(toolName, action, `Stopped supervised daemon '${toolName}'`, tool);

      case "restart":
        if (this.daemons.has(toolName)) {
          await this.stopToolDaemon(toolName);
        }
        await this.startToolDaemon(tool);
        await this.waitForDaemonStateToSettle(toolName);
        return this.buildStatus(
          toolName,
          action,
          this.daemons.get(toolName)?.child?.pid
            ? `Restarted supervised daemon '${toolName}' (pid ${this.daemons.get(toolName)?.child?.pid})`
            : `Requested restart for supervised daemon '${toolName}'`,
          tool,
        );
    }
  }

  stopAll(): Promise<void> {
    const promises = [...this.daemons.keys()].map((name) => this.stopToolDaemon(name));
    return Promise.all(promises).then(() => {});
  }

  private spawnDaemonProcess(managed: ManagedDaemon): void {
    const spec = buildDaemonSpawnSpec(managed.config.command);
    if (!spec) {
      log("warn", `external-tools: empty daemon command for '${managed.toolName}'`);
      return;
    }

    // Ensure config/ dir exists for the log/state files
    const { configDir, logPath } = getDaemonStatePaths(managed.toolDir);
    mkdirSync(configDir, { recursive: true });
    const logFd = openSync(logPath, "a");

    try {
      const child = spawn(spec.cmd, spec.args, {
        cwd: managed.toolDir,
        stdio: ["ignore", logFd, logFd],
        env: { ...process.env, ...managed.config.env },
        detached: true,
      });

      managed.child = child;
      managed.lastStartTime = Date.now();

      if (child.pid) {
        writeDaemonPidFile(managed.toolDir, child.pid);
      }

      log("info", `external-tools: started daemon '${managed.toolName}' (pid ${child.pid})`);

      child.on("error", (err) => {
        log("warn", `external-tools: daemon '${managed.toolName}' spawn error: ${err.message}`);
        managed.child = null;
        clearDaemonPidFile(managed.toolDir);
        this.scheduleDaemonRestart(managed);
      });

      child.on("exit", (code, signal) => {
        managed.child = null;
        clearDaemonPidFile(managed.toolDir);

        if (managed.stopping) return;

        log("warn", `external-tools: daemon '${managed.toolName}' exited (code=${code}, signal=${signal})`);

        const policy = managed.config.restart ?? "on-failure";
        const shouldRestart =
          policy === "always" || (policy === "on-failure" && code !== 0);

        if (shouldRestart) {
          this.scheduleDaemonRestart(managed);
        }
      });
    } finally {
      // Parent closes its copy — child inherited the fd on spawn
      closeSync(logFd);
    }
  }

  private trySpawnDaemonProcess(managed: ManagedDaemon): void {
    try {
      this.spawnDaemonProcess(managed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      managed.child = null;
      clearDaemonPidFile(managed.toolDir);
      log("warn", `external-tools: failed to start daemon '${managed.toolName}': ${msg}`);
      if (!managed.stopping) {
        this.scheduleDaemonRestart(managed);
      }
    }
  }

  private scheduleDaemonRestart(managed: ManagedDaemon): void {
    if (managed.stopping) return;

    // Reset backoff after sustained uptime
    const uptime = Date.now() - managed.lastStartTime;
    if (uptime > BACKOFF_RESET_MS) managed.restartCount = 0;

    const delay = BACKOFF_MS[Math.min(managed.restartCount, BACKOFF_MS.length - 1)];
    managed.restartCount++;

    log("info", `external-tools: restarting daemon '${managed.toolName}' in ${delay / 1000}s (attempt ${managed.restartCount})`);

    managed.restartTimer = setTimeout(() => {
      managed.restartTimer = null;
      if (!managed.stopping) this.trySpawnDaemonProcess(managed);
    }, delay);
    managed.restartTimer.unref?.();
  }

  private async startToolDaemon(tool: LoadedTool): Promise<void> {
    if (!tool.manifest.daemon) return;

    let managed = this.daemons.get(tool.manifest.name);
    if (managed?.child || managed?.starting) return; // already running / starting

    if (!managed) {
      managed = {
        toolName: tool.manifest.name,
        toolDir: tool.toolDir,
        config: tool.manifest.daemon,
        child: null,
        restartCount: 0,
        restartTimer: null,
        lastStartTime: 0,
        stopping: false,
        starting: false,
      };
      this.daemons.set(tool.manifest.name, managed);
    } else {
      managed.toolDir = tool.toolDir;
      managed.config = tool.manifest.daemon;
      managed.stopping = false;
    }

    managed.starting = true;
    try {
      await reapStaleManagedDaemonPid(managed.toolDir, managed.toolName);
      if (!managed.stopping) {
        this.trySpawnDaemonProcess(managed);
      }
    } finally {
      managed.starting = false;
      if (managed.stopping && !managed.child) {
        this.daemons.delete(tool.manifest.name);
      }
    }
  }

  private stopToolDaemon(name: string): Promise<void> {
    const managed = this.daemons.get(name);
    if (!managed) return Promise.resolve();

    managed.stopping = true;

    if (managed.restartTimer) {
      clearTimeout(managed.restartTimer);
      managed.restartTimer = null;
    }

    if (!managed.child || !managed.child.pid) {
      clearDaemonPidFile(managed.toolDir);
      this.daemons.delete(name);
      return Promise.resolve();
    }

    const child = managed.child;
    const pid = child.pid!;

    return new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        managed.child = null;
        clearDaemonPidFile(managed.toolDir);
        this.daemons.delete(name);
        resolve();
      };

      child.once("exit", () => {
        log("info", `external-tools: daemon '${name}' stopped (pid ${pid})`);
        settle();
      });

      void killProcessGroup(pid, `daemon '${name}'`).then(() => {
        settle();
      });
    });
  }

  private getToolByName(name: string): LoadedTool | null {
    return this.tools.find((tool) => tool.manifest.name === name) ?? null;
  }

  private buildStatus(
    toolName: string,
    action: ExternalToolDaemonAction,
    message: string,
    tool: LoadedTool | null = this.getToolByName(toolName),
  ): ExternalToolDaemonStatus {
    const managed = this.daemons.get(toolName) ?? null;
    const configured = Boolean(tool?.manifest.daemon);
    const pid = managed?.child?.pid ?? null;
    return {
      toolName,
      action,
      configured,
      managed: managed !== null,
      running: pid !== null,
      pid,
      restartPolicy: tool?.manifest.daemon?.restart ?? (configured ? "on-failure" : null),
      message,
    };
  }

  private async waitForDaemonStateToSettle(toolName: string, checks = 4, delayMs = 50): Promise<void> {
    for (let i = 0; i < checks; i++) {
      await sleep(delayMs);
      const managed = this.daemons.get(toolName);
      if (!managed?.starting) return;
    }
  }
}
