/**
 * IPC protocol for the Exocortex TUI.
 *
 * Daemon commands/events come from the shared wire protocol. Transport status
 * is TUI-local: it is synthesized by DaemonClient and never reaches a daemon.
 */

export * from "@exocortex/shared/protocol";

import type { Event as DaemonEvent } from "@exocortex/shared/protocol";

export interface SshStatusEvent {
  type: "ssh_status";
  mode: "local" | "remote";
  state: "connected" | "switching" | "failed";
  alias?: string;
  /** True only when a successful local command changed this TUI's endpoint. */
  switched: boolean;
  /** Session bootstrap notification used only to restore indicators after reconnect. */
  silent?: boolean;
  message: string;
}

/** Events consumed by the TUI, including local transport-control events. */
export type Event = DaemonEvent | SshStatusEvent;
