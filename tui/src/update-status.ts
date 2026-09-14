import { DAEMON_STATUS_INTERVAL_MS, type UpdateStatus } from "@exocortex/shared/updatecheck";
import { DaemonClient } from "./client";

export interface UpdateSnapshot {
  local: UpdateStatus;
  /** null means this TUI is on its local route. */
  remote: UpdateStatus | null;
}

/**
 * A separate, short-lived LOCAL connection while the main client is on SSH.
 * Never switch the user's active route or request conversation bootstrap.
 */
export async function queryLocalUpdateStatus(overrideSocketPath?: string): Promise<UpdateStatus> {
  const client = new DaemonClient(() => {}, overrideSocketPath);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        await client.connect();
        return await client.requestUpdateStatus();
      })(),
      new Promise<UpdateStatus>(resolve => {
        timer = setTimeout(() => { client.disconnect(); resolve("unknown"); }, 25_000);
        timer.unref();
      }),
    ]);
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
    client.disconnect();
  }
}

/** Owns the timer and rejects stale results after route changes/reconnects. */
export class UpdateStatusMonitor {
  private generation = 0;
  private inFlight = new Set<number>();
  private stopped = false;
  private alias: string | null;
  private snapshot: UpdateSnapshot = { local: "unknown", remote: null };
  private timer: ReturnType<typeof setInterval>;

  constructor(
    alias: string | null,
    private readonly active: () => Promise<UpdateStatus>,
    private readonly local: () => Promise<UpdateStatus>,
    private readonly onChange: (snapshot: UpdateSnapshot) => void,
    intervalMs = DAEMON_STATUS_INTERVAL_MS,
  ) {
    this.alias = alias;
    this.snapshot.remote = alias ? "unknown" : null;
    this.onChange({ ...this.snapshot });
    this.timer = setInterval(() => { void this.refresh(); }, intervalMs);
    this.timer.unref();
    void this.refresh();
  }

  /** Call even for same-alias reconnects: the daemon may have restarted. */
  setRoute(alias: string | null): void {
    this.generation++;
    this.alias = alias;
    this.publish({ local: this.snapshot.local, remote: alias ? "unknown" : null });
    void this.refresh();
  }

  disconnected(): void {
    this.generation++;
    this.publish(this.alias
      ? { local: this.snapshot.local, remote: "unknown" }
      : { local: "unknown", remote: null });
  }

  private publish(snapshot: UpdateSnapshot): void {
    if (snapshot.local === this.snapshot.local && snapshot.remote === this.snapshot.remote) return;
    this.snapshot = snapshot;
    if (!this.stopped) this.onChange({ ...snapshot });
  }

  async refresh(): Promise<void> {
    const generation = this.generation;
    if (this.stopped || this.inFlight.has(generation)) return;
    this.inFlight.add(generation);
    const safe = async (query: () => Promise<UpdateStatus>): Promise<UpdateStatus> => {
      try { return await query(); } catch { return "unknown"; }
    };
    try {
      const remote = Boolean(this.alias);
      // Publish independently so an unavailable SSH host never delays Local.
      await Promise.all([
        safe(this.active).then(status => {
          if (this.stopped || generation !== this.generation) return;
          this.publish(remote ? { ...this.snapshot, remote: status } : { local: status, remote: null });
        }),
        ...(remote ? [safe(this.local).then(status => {
          if (!this.stopped && generation === this.generation) this.publish({ ...this.snapshot, local: status });
        })] : []),
      ]);
    } finally { this.inFlight.delete(generation); }
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    clearInterval(this.timer);
  }
}
