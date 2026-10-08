export interface FirstTextTiming {
  convId: string;
  startedAt: number;
  receivedMs: number;
  renderedMs: number;
  receiveToRenderMs: number;
}

/** First real assistant text gets an immediate frame; later chunks stay batched. */
export class FirstTextUX {
  private key: string | null = null;
  private started: number | undefined;
  private received: number | undefined;
  private seen = false;
  private pendingFrame = false;
  constructor(private readonly report?: (timing: FirstTextTiming) => void, private readonly now = () => performance.now()) {}

  start(convId: string, startedAt: number): void {
    this.key = `${convId}:${startedAt}`;
    this.started = this.report ? this.now() : undefined;
    this.received = undefined;
    this.seen = false;
    this.pendingFrame = false;
  }

  onText(convId: string, startedAt: number, text: string): boolean {
    if (!/\S/.test(text)) return false;
    if (this.key !== `${convId}:${startedAt}`) {
      this.start(convId, startedAt);
      this.started = undefined; // late join/background turns have no local submit clock
    }
    if (this.seen) return false;
    this.seen = true;
    this.pendingFrame = true;
    this.received = this.report ? this.now() : undefined;
    return true;
  }

  onFrame(convId: string, startedAt: number): void {
    if (!this.pendingFrame || this.key !== `${convId}:${startedAt}`) return;
    this.pendingFrame = false;
    if (this.report && this.started != null && this.received != null) {
      const rendered = this.now();
      this.report({ convId, startedAt, receivedMs: this.received - this.started,
        renderedMs: rendered - this.started, receiveToRenderMs: rendered - this.received });
    }
  }
}
