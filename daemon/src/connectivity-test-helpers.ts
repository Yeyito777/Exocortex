/** Deterministic clock and probe for connectivity tests. */

import type { ConnectivityClock } from "./connectivity";

/** Manual clock: timers fire only when the test advances time. */
export class FakeClock implements ConnectivityClock {
  time = 1_000_000;
  private timers: Array<{ at: number; callback: () => void; handle: number }> = [];
  private nextHandle = 1;

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = this.nextHandle++;
    this.timers.push({ at: this.time + delayMs, callback, handle });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter(timer => timer.handle !== handle);
  }

  pendingDelays(): number[] {
    return this.timers.map(timer => timer.at - this.time);
  }

  /** Advance time, firing due timers in order and letting their promises settle. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    while (true) {
      const due = this.timers.filter(timer => timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter(timer => timer !== due);
      this.time = due.at;
      due.callback();
      await flush();
    }
    this.time = target;
    await flush();
  }
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** A probe whose answer the test controls; counts calls. */
export function scriptedProbe(initial: boolean) {
  const probe = Object.assign(async () => {
    probe.calls += 1;
    return probe.reachable;
  }, { calls: 0, reachable: initial });
  return probe;
}
