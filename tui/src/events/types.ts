import type { ImageAttachment } from "../messages";

// Minimal interface so event handling doesn't depend on DaemonClient.
export interface DaemonActions {
  subscribe(convId: string): void;
  unsubscribe(convId: string): void;
  sendMessage(convId: string, text: string, startedAt: number, images?: ImageAttachment[]): void;
  setSystemInstructions(convId: string, text: string): void;
  /** Returns the request id when the transport assigns one. */
  loadToolOutputs(convId: string, toolCallIds?: string[]): string | void;
}
