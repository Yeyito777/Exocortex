import { describe, expect, test } from "bun:test";
import { CONTEXT_COMPACTION_FINISHED_KIND, FOLDER_AGENTS_NOTICE_KIND, type FolderAgentRef, type StoredMessage } from "./messages";
import { FOLDER_AGENT_WORKING_WINDOW_MS, folderAgentsNotice, workingFolderAgents, type FolderAgentCandidate } from "./folder-agents";
import { pendingTurnNotices, turnNoticeMessages } from "./turn-notices";

const NOW = 1_800_000_000_000;

function candidate(id: string, extra: Partial<FolderAgentCandidate> = {}): FolderAgentCandidate {
  return { id, title: `Title ${id}`, folderId: "proj", streaming: false, lastActivityAt: NOW, ...extra };
}

const self = { id: "me", folderId: "proj", parentConversationId: "boss" };

describe("which agents are working in the folder", () => {
  test("other conversations in the same folder that are streaming or active within the window", () => {
    const agents = workingFolderAgents(self, [
      candidate("me"),
      candidate("b-recent", { lastActivityAt: NOW - FOLDER_AGENT_WORKING_WINDOW_MS + 1 }),
      candidate("c-stale", { lastActivityAt: NOW - FOLDER_AGENT_WORKING_WINDOW_MS - 1 }),
      candidate("d-streaming", { streaming: true, lastActivityAt: NOW - 10 * FOLDER_AGENT_WORKING_WINDOW_MS }),
      candidate("e-elsewhere", { folderId: "other" }),
      candidate("f-top", { folderId: null }),
    ], "subs", NOW);
    expect(agents?.map(agent => agent.id)).toEqual(["b-recent", "d-streaming"]);
  });

  test("the window is 30 minutes", () => {
    expect(FOLDER_AGENT_WORKING_WINDOW_MS).toBe(30 * 60_000);
  });

  test("say nothing at the top level or in the default subagents folder", () => {
    expect(workingFolderAgents({ ...self, folderId: null }, [candidate("b", { folderId: null })], "subs", NOW)).toBeNull();
    expect(workingFolderAgents({ ...self, folderId: "subs" }, [candidate("b", { folderId: "subs" })], "subs", NOW)).toBeNull();
  });

  test("mark the parent and subagents, and a working directory only when it differs", () => {
    const agents = workingFolderAgents({ ...self, cwd: "/repo" }, [
      candidate("boss"),
      candidate("kid", { parentConversationId: "me", cwd: "/repo" }),
      candidate("app", { cwd: "/elsewhere" }),
    ], "subs", NOW);
    expect(agents).toEqual([
      { id: "app", title: "Title app", cwd: "/elsewhere" },
      { id: "boss", title: "Title boss", relation: "parent" },
      { id: "kid", title: "Title kid", relation: "subagent" },
    ]);
  });
});

const boss: FolderAgentRef = { id: "1791667824123-k14mhj", title: "Paramount", relation: "parent" };
const peer: FolderAgentRef = { id: "1795737888601-33vb1t", title: "Fix the  sidebar\ncards" };
const late: FolderAgentRef = { id: "1795739999999-zzzzzz", title: "Docs pass", cwd: "/home/me/wt" };

describe("what the model is told", () => {
  test("the first block lists every agent, in the owner's wording", () => {
    expect(folderAgentsNotice(null, [boss, peer])).toEqual({
      kind: FOLDER_AGENTS_NOTICE_KIND,
      text: "[info] There are other agents working in this project: {1791667824123-k14mhj: Paramount (your parent), 1795737888601-33vb1t: Fix the sidebar cards}",
      metadata: { folderAgents: [boss, peer] },
    });
  });

  test("nothing when no one else is working, or in a catch-all place", () => {
    expect(folderAgentsNotice(null, [])).toBeNull();
    expect(folderAgentsNotice(null, null)).toBeNull();
    expect(folderAgentsNotice([boss], null)).toBeNull();
  });

  test("nothing while the set is unchanged, whatever its order or titles", () => {
    expect(folderAgentsNotice([boss, peer], [{ ...peer, title: "Renamed" }, boss])).toBeNull();
  });

  test("an update says who joined and who finished", () => {
    expect(folderAgentsNotice([boss, peer], [boss, late])?.text).toBe(
      "[info] The other agents working in this project changed. Joined: {1795739999999-zzzzzz: Docs pass (working in /home/me/wt)}. Finished: {1795737888601-33vb1t: Fix the sidebar cards}.",
    );
    expect(folderAgentsNotice([boss], [])?.text).toBe(
      "[info] The other agents working in this project changed. Finished: {1791667824123-k14mhj: Paramount (your parent)}. No other agents are working in this project now.",
    );
    expect(folderAgentsNotice([], [peer])?.text).toBe(
      "[info] The other agents working in this project changed. Joined: {1795737888601-33vb1t: Fix the sidebar cards}.",
    );
  });
});

describe("folder agents as a turn notice", () => {
  const state = (messages: StoredMessage[], folderAgents: FolderAgentRef[] | null) => ({ id: "me", messages, subagentPolicy: null, goal: null, folderAgents });
  const compaction: StoredMessage = {
    role: "system",
    content: "--- Compaction finished ---",
    metadata: { startedAt: 2, endedAt: 2, model: "model", tokens: 0, kind: CONTEXT_COMPACTION_FINISHED_KIND },
  };

  test("reads what it last told from history: once, then only changes", () => {
    const [first] = pendingTurnNotices(state([], [boss]));
    expect(first?.kind).toBe(FOLDER_AGENTS_NOTICE_KIND);
    const history = turnNoticeMessages([first!], "model", 1);
    expect(history[0]).toMatchObject({ role: "user", content: first!.text, metadata: { system: true, kind: FOLDER_AGENTS_NOTICE_KIND, folderAgents: [boss] } });
    expect(pendingTurnNotices(state(history, [boss]))).toEqual([]);
    const [update] = pendingTurnNotices(state(history, [boss, peer]));
    expect(update?.text).toContain("Joined: {1795737888601-33vb1t: Fix the sidebar cards}.");
  });

  test("is repeated in full after a compaction", () => {
    const history = [...turnNoticeMessages(pendingTurnNotices(state([], [boss])), "model", 1), compaction];
    expect(pendingTurnNotices(state(history, [boss]))[0]?.text).toStartWith("[info] There are other agents working in this project:");
  });
});
