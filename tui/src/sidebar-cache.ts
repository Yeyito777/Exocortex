/**
 * Transport-only copy of a remote daemon's sidebar for `sidebar-digest-sync`.
 *
 * Over /ssh the full conversation list (MBs of JSON for thousands of
 * conversations) used to be resent on every reconnect. This cache keeps the
 * last list as serialized rows, follows sidebar events to stay close to the
 * daemon's copy, and sends a digest of it with the reconnect probe. The daemon
 * answers with only the rows of buckets whose hash differs; the cache rebuilds
 * the full list before any UI handler sees it. Buckets are reused only when
 * their exact content hash matches, so drift in this copy costs bytes, never
 * correctness. Rows are kept per SSH alias across route switches (a digest
 * is only offered to the alias they came from) so returning to a host is
 * incremental too.
 */

import { computeSidebarDigest, sidebarBucket, type SidebarDigest } from "@exocortex/shared/sidebar-digest";
import type { Event } from "./protocol";

interface Snapshot {
  rows: Map<string, string>;
  foldersJson: string;
}

export class SidebarCache {
  private rows = new Map<string, string>();
  private foldersJson: string | null = null;
  /** SSH alias the rows came from; a digest is never sent to another endpoint. */
  private alias: string | null = null;
  /** The exact base a sent digest describes, until its answer arrives. */
  private pinned: Snapshot | null = null;

  clear(): void {
    this.rows = new Map();
    this.foldersJson = null;
    this.alias = null;
    this.pinned = null;
  }

  /** Digest to send ahead of a probe to `alias`, or null when nothing can be reused. */
  beginSync(alias: string): SidebarDigest | null {
    this.pinned = null;
    if (this.alias !== alias || this.foldersJson === null || this.rows.size === 0) return null;
    this.pinned = { rows: new Map(this.rows), foldersJson: this.foldersJson };
    return computeSidebarDigest(this.pinned.rows, this.pinned.foldersJson);
  }

  /**
   * Observe an event from the remote route `alias`. Returns the event to
   * deliver (a digest answer rebuilt into a full list), or null when a digest
   * answer cannot be rebuilt and the caller must request a full list.
   */
  receive(event: Event, alias: string): Event | null {
    if (this.alias !== alias) {
      this.clear();
      this.alias = alias;
    }
    switch (event.type) {
      case "conversations_list": {
        const base = this.pinned;
        this.pinned = null;
        if (!event.sidebarBuckets) {
          this.replace(event.conversations, event.folders ?? []);
          return event;
        }
        if (!base) return null;
        const changed = new Set(event.sidebarBuckets);
        const rows = new Map<string, string>();
        for (const [id, json] of base.rows) if (!changed.has(sidebarBucket(id))) rows.set(id, json);
        for (const conversation of event.conversations) rows.set(conversation.id, JSON.stringify(conversation));
        this.rows = rows;
        this.foldersJson = event.folders ? JSON.stringify(event.folders) : base.foldersJson;
        const { sidebarBuckets: _buckets, ...rest } = event;
        return {
          ...rest,
          conversations: JSON.parse(`[${[...rows.values()].join(",")}]`),
          folders: JSON.parse(this.foldersJson),
        };
      }
      case "conversation_moved":
        this.replace(event.conversations, event.folders ?? this.parsedFolders());
        return event;
      case "conversation_updated":
      case "conversation_restored":
      case "conversation_unwound":
        this.rows.set(event.summary.id, JSON.stringify(event.summary));
        return event;
      case "conversation_deleted":
        this.rows.delete(event.convId);
        return event;
      case "conversation_marked":
        this.patchRow(event.convId, { marked: event.marked });
        return event;
      case "conversation_pinned":
        this.patchRow(event.convId, { pinned: event.pinned });
        return event;
      case "sidebar_items_reordered": {
        const folderOrders = new Map<string, number>();
        for (const update of event.updates) {
          if (update.item.type === "conversation") this.patchRow(update.item.id, { sortOrder: update.sortOrder });
          else folderOrders.set(update.item.id, update.sortOrder);
        }
        if (folderOrders.size > 0) this.patchFolders(folders => folders.map(folder =>
          folderOrders.has(folder.id) ? { ...folder, sortOrder: folderOrders.get(folder.id) } : folder));
        return event;
      }
      case "sidebar_state_patched": {
        for (const conversation of event.conversations ?? []) this.rows.set(conversation.id, JSON.stringify(conversation));
        for (const id of event.removedConversationIds ?? []) this.rows.delete(id);
        if (event.folders?.length || event.removedFolderIds?.length) {
          const removed = new Set(event.removedFolderIds ?? []);
          const upserts = new Map((event.folders ?? []).map(folder => [folder.id, folder]));
          this.patchFolders(folders => {
            const next = folders.filter(folder => !removed.has(folder.id)).map(folder => upserts.get(folder.id) ?? folder);
            for (const [id, folder] of upserts) if (!folders.some(existing => existing.id === id)) next.push(folder);
            return next;
          });
        }
        return event;
      }
      default:
        return event;
    }
  }

  private replace(conversations: Array<{ id: string }>, folders: unknown[]): void {
    this.rows = new Map(conversations.map(conversation => [conversation.id, JSON.stringify(conversation)]));
    this.foldersJson = JSON.stringify(folders);
  }

  private patchRow(id: string, patch: Record<string, unknown>): void {
    const json = this.rows.get(id);
    if (json !== undefined) this.rows.set(id, JSON.stringify({ ...JSON.parse(json), ...patch }));
  }

  private parsedFolders(): Array<{ id: string; [key: string]: unknown }> {
    return this.foldersJson === null ? [] : JSON.parse(this.foldersJson);
  }

  private patchFolders(update: (folders: Array<{ id: string; [key: string]: unknown }>) => unknown[]): void {
    if (this.foldersJson !== null) this.foldersJson = JSON.stringify(update(this.parsedFolders()));
  }
}
