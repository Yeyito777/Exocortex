/**
 * Which other agents are working in a conversation's folder, told to it as a
 * turn notice (turn-notices.ts) so agents sharing a project can coordinate
 * before shared-state actions (commits, git stash, daemon restarts).
 *
 * A conversation is told the whole set on its first turn-starting message
 * that has one, then only who joined and who finished when the set changes.
 * Catch-all places are skipped: the top level and the default subagents
 * folder. The set each notice left the model with is kept on the notice
 * (metadata.folderAgents), so what the model was told is read from history.
 * The daemon's lookup is conversations.ts's currentFolderAgents.
 */

import { FOLDER_AGENTS_NOTICE_KIND, type FolderAgentRef } from "@exocortex/shared/messages";

/** "Working": streaming now, or active within this long. */
export const FOLDER_AGENT_WORKING_WINDOW_MS = 30 * 60_000;

export interface FolderAgentCandidate {
  id: string;
  title: string;
  folderId: string | null;
  parentConversationId?: string | null;
  streaming: boolean;
  /** Last activity (the summary's updatedAt). */
  lastActivityAt: number;
  /** The directory its turns run in when it is not its own workspace (an app's cwd). */
  cwd?: string | null;
}

export interface FolderAgentSelf {
  id: string;
  folderId: string | null;
  parentConversationId?: string | null;
  cwd?: string | null;
}

/**
 * The agents working in `self`'s folder, ordered by id, or null when the
 * conversation sits in a catch-all place (nothing is said there).
 */
export function workingFolderAgents(
  self: FolderAgentSelf,
  candidates: Iterable<FolderAgentCandidate>,
  subagentsFolderId: string | null,
  now: number,
): FolderAgentRef[] | null {
  const folderId = self.folderId ?? null;
  if (folderId === null || folderId === subagentsFolderId) return null;
  const selfCwd = self.cwd ?? null;
  const agents: FolderAgentRef[] = [];
  for (const candidate of candidates) {
    if (candidate.id === self.id || (candidate.folderId ?? null) !== folderId) continue;
    if (!candidate.streaming && now - candidate.lastActivityAt > FOLDER_AGENT_WORKING_WINDOW_MS) continue;
    const relation = candidate.id === self.parentConversationId ? "parent"
      : candidate.parentConversationId === self.id ? "subagent"
        : undefined;
    const cwd = candidate.cwd ?? null;
    agents.push({
      id: candidate.id,
      title: candidate.title,
      ...(relation ? { relation } : {}),
      ...(cwd !== null && cwd !== selfCwd ? { cwd } : {}),
    });
  }
  return agents.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function entry(agent: FolderAgentRef): string {
  const title = agent.title.replace(/\s+/g, " ").trim() || "untitled";
  const notes = [
    ...(agent.relation ? [`your ${agent.relation}`] : []),
    ...(agent.cwd ? [`working in ${agent.cwd}`] : []),
  ];
  return `${agent.id}: ${title}${notes.length ? ` (${notes.join(", ")})` : ""}`;
}

function list(agents: readonly FolderAgentRef[]): string {
  return `{${agents.map(entry).join(", ")}}`;
}

export interface FolderAgentsNotice {
  kind: typeof FOLDER_AGENTS_NOTICE_KIND;
  text: string;
  metadata: { folderAgents: FolderAgentRef[] };
}

/**
 * What to tell the model, given the set it was last told (null: never told,
 * or told before the latest compaction) and the current one (null: a
 * catch-all place). Null when there is nothing to say.
 */
export function folderAgentsNotice(told: readonly FolderAgentRef[] | null, current: readonly FolderAgentRef[] | null): FolderAgentsNotice | null {
  if (current === null) return null;
  const metadata = { folderAgents: current.map(agent => ({ ...agent })) };
  if (told === null) {
    if (current.length === 0) return null;
    return { kind: FOLDER_AGENTS_NOTICE_KIND, text: `[info] There are other agents working in this project: ${list(current)}`, metadata };
  }
  const before = new Set(told.map(agent => agent.id));
  const now = new Set(current.map(agent => agent.id));
  const joined = current.filter(agent => !before.has(agent.id));
  const finished = told.filter(agent => !now.has(agent.id));
  if (joined.length === 0 && finished.length === 0) return null;
  const parts = ["[info] The other agents working in this project changed."];
  if (joined.length) parts.push(`Joined: ${list(joined)}.`);
  if (finished.length) parts.push(`Finished: ${list(finished)}.`);
  if (current.length === 0) parts.push("No other agents are working in this project now.");
  return { kind: FOLDER_AGENTS_NOTICE_KIND, text: parts.join(" "), metadata };
}
