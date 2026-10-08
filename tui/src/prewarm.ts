export interface PrewarmContext {
  convId: string | null;
  provider: string;
  model: string;
  effort: string;
  fastMode: boolean | string;
  eligible: boolean;
}

/** Reserve a draft transport, not a conversation row. No typing debounce. */
export class ConversationPrewarmer {
  private draftId: string | null = null;
  private lastKey: string | null = null;
  private lastAt = 0;

  constructor(
    private readonly send: (convId: string, draft: boolean) => void,
    private readonly generateId: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  observe(context: PrewarmContext): void {
    if (!context.eligible || context.provider !== "openai") return;
    const convId = context.convId ?? (this.draftId ??= this.generateId());
    const key = `${convId}:${context.model}:${context.effort}:${context.fastMode}`;
    const now = this.now();
    if (key === this.lastKey && now - this.lastAt < 30_000) return;
    this.lastKey = key;
    this.lastAt = now;
    this.send(convId, context.convId === null);
  }

  takeDraftId(): string | null {
    const id = this.draftId;
    this.draftId = null;
    return id;
  }

  reset(): void {
    this.draftId = null;
    this.lastKey = null;
    this.lastAt = 0;
  }
}
