// Minimal raw-socket client for the app API e2e (no client library on purpose).
import { connect, type Socket } from "node:net";

export type Json = Record<string, any>;

export class RawClient {
  private socket!: Socket;
  private buffer = "";
  readonly events: Json[] = [];
  private waiters: Array<{ match: (event: Json) => boolean; resolve: (event: Json) => void }> = [];
  private seq = 0;
  closed = false;
  /** Called for every event (e.g. auto-answering app tool calls). */
  onEvent: ((event: Json) => void) | null = null;
  transcript: string[] | null = null;

  static async open(path: string): Promise<RawClient> {
    const client = new RawClient();
    await new Promise<void>((resolve, reject) => {
      client.socket = connect(path, () => resolve());
      client.socket.once("error", reject);
    });
    client.socket.setEncoding("utf8");
    client.socket.on("data", (chunk: string) => client.onData(chunk));
    client.socket.on("close", () => { client.closed = true; });
    return client;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      const event = JSON.parse(line) as Json;
      this.transcript?.push(`← ${line}`);
      this.events.push(event);
      this.onEvent?.(event);
      for (const waiter of [...this.waiters]) {
        if (waiter.match(event)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(event);
        }
      }
    }
  }

  reqId(): string {
    return `r${++this.seq}`;
  }

  send(command: Json): void {
    const line = JSON.stringify(command);
    this.transcript?.push(`→ ${line}`);
    this.socket.write(line + "\n");
  }

  /** The next event (after now, or already buffered after `since`) matching. */
  wait(match: (event: Json) => boolean, timeoutMs = 120_000, since = this.events.length): Promise<Json> {
    const existing = this.events.slice(since).find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve: (event: Json) => { clearTimeout(timer); resolve(event); } };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`timed out after ${timeoutMs} ms waiting for an event`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Send and wait for the answer carrying its reqId (any of `types`, or error). */
  async request(command: Json, types: string[], timeoutMs = 120_000): Promise<Json> {
    const reqId = command.reqId ?? this.reqId();
    const since = this.events.length;
    this.send({ ...command, reqId });
    const answer = await this.wait(event => event.reqId === reqId && (types.includes(event.type) || event.type === "error"), timeoutMs, since);
    return answer;
  }

  close(): void {
    this.socket.end();
    this.socket.destroy();
  }
}
