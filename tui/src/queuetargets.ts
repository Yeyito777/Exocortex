import type { CompletionItem } from "./commands/types";
import type { ConversationSummary, FolderSummary } from "./messages";
import type { QueueWaitTarget, RenderState } from "./state";
import { folderDescendantConversations, folderPath } from "./sidebar/folders";

const FOLDER_ICON = "📁";
const QUEUE_TARGET_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export interface QueueTargetCandidate {
  type: "conversation" | "folder";
  id: string;
  label: string;
  completionName: string;
  aliases: string[];
  desc: string;
  waitTarget: QueueWaitTarget;
}

function nonEmptyLabel(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function conversationTitle(conv: Pick<ConversationSummary, "title">): string {
  return nonEmptyLabel(conv.title, "Untitled");
}

function folderLabel(state: RenderState, folder: Pick<FolderSummary, "id" | "name">): string {
  return nonEmptyLabel(folderPath(state.sidebar, folder.id), nonEmptyLabel(folder.name, "Folder"));
}

function formatQueueTargetTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "unknown";
  return QUEUE_TARGET_TIME_FORMATTER.format(timestamp);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function conversationCandidates(state: RenderState): QueueTargetCandidate[] {
  return [...state.sidebar.conversations]
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .map((conv) => {
      const title = conversationTitle(conv);
      const folder = conv.folderId ? folderPath(state.sidebar, conv.folderId) : "";
      const descBits = ["conversation", `updated ${formatQueueTargetTime(conv.updatedAt)}`, conv.id];
      if (folder) descBits.splice(1, 0, `in ${folder}`);
      return {
        type: "conversation" as const,
        id: conv.id,
        label: title,
        completionName: title,
        aliases: uniqueStrings([title, conv.id]),
        desc: descBits.join(" • "),
        waitTarget: { type: "conversation" as const, convId: conv.id, label: title },
      };
    });
}

function folderCandidates(state: RenderState): QueueTargetCandidate[] {
  return [...state.sidebar.folders]
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((folder) => {
      const label = folderLabel(state, folder);
      const childCount = folderDescendantConversations(state.sidebar, folder.id).length;
      const descBits = [`${FOLDER_ICON} folder`, `${childCount} conversation${childCount === 1 ? "" : "s"}`];
      return {
        type: "folder" as const,
        id: folder.id,
        label,
        completionName: `${FOLDER_ICON} ${label}`,
        aliases: uniqueStrings([label, folder.name, folder.id]),
        desc: descBits.join(" • "),
        waitTarget: { type: "folder" as const, folderId: folder.id, label },
      };
    });
}

export function queueTargetCandidates(state: RenderState): QueueTargetCandidate[] {
  // Conversations intentionally come first, newest to oldest.  Duplicate titles
  // are common, so both autocomplete and name resolution prefer the freshest
  // matching conversation unless the user explicitly selects/types the folder icon.
  return [...conversationCandidates(state), ...folderCandidates(state)];
}

export function queueTargetCompletionItems(state: RenderState): CompletionItem[] {
  return queueTargetCandidates(state).map((candidate) => ({
    name: candidate.completionName,
    desc: candidate.desc,
    aliases: candidate.aliases,
  }));
}

function isBoundary(text: string, index: number): boolean {
  return index >= text.length || /\s/.test(text[index]);
}

function candidateForms(candidate: QueueTargetCandidate): string[] {
  return uniqueStrings([candidate.completionName, candidate.label, ...candidate.aliases])
    .sort((a, b) => b.length - a.length);
}

interface PrefixMatch {
  target: QueueWaitTarget;
  length: number;
  candidateIndex: number;
}

function bestQueueTargetPrefixMatch(state: RenderState, text: string): PrefixMatch | null {
  const lower = text.toLowerCase();
  const matches: PrefixMatch[] = [];
  const candidates = queueTargetCandidates(state);
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
    const candidate = candidates[candidateIndex];
    for (const form of candidateForms(candidate)) {
      if (!lower.startsWith(form.toLowerCase())) continue;
      if (!isBoundary(text, form.length)) continue;
      matches.push({ target: candidate.waitTarget, length: form.length, candidateIndex });
      break;
    }
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.length - a.length || a.candidateIndex - b.candidateIndex);
  return matches[0];
}

export interface QueueTargetAtMatch {
  target: QueueWaitTarget;
  end: number;
}

export function matchQueueTargetAfterCommand(state: RenderState, text: string, commandEnd: number): QueueTargetAtMatch | null {
  let argStart = commandEnd;
  if (argStart >= text.length || !/\s/.test(text[argStart])) return null;
  while (argStart < text.length && /\s/.test(text[argStart])) argStart++;
  if (argStart >= text.length) return null;

  const match = bestQueueTargetPrefixMatch(state, text.slice(argStart));
  if (!match) return null;
  return { target: match.target, end: argStart + match.length };
}
