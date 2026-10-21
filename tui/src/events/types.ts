import type { ImageAttachment } from "../messages";
import type { UserMacro } from "@exocortex/shared/user-macros";

// Minimal interface so event handling doesn't depend on DaemonClient.
export interface DaemonActions {
  subscribe(convId: string): void;
  unsubscribe(convId: string): void;
  sendMessage(convId: string, text: string, startedAt: number, images?: ImageAttachment[]): void;
  /** Re-queues a direct send that lost the race to a daemon-started turn. */
  queueMessage?(convId: string, text: string, timing: "message-end", images: ImageAttachment[] | undefined, options: { queueId: string }): void;
  setSystemInstructions(convId: string, text: string): string | void;
  /** /instructions: loads and saves that wait for a check after reconnecting (see instructions/store). */
  readonly connected?: boolean;
  loadInstructions?(convId: string | null, folderId: string | null): string;
  setFolderInstructions?(folderId: string, text: string): string;
  setGlobalInstructions?(text: string, expectedText?: string): string;
  /** /macro: changes the store confirms in the background (see usermacros/store). */
  saveUserMacro?(macro: UserMacro, create: boolean): string | null;
  deleteUserMacro?(name: string): string | null;
  /** Returns the request id when the transport assigns one. */
  loadToolOutputs(convId: string, toolCallIds?: string[]): string | void;
}
