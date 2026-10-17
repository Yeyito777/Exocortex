import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ClientHostInfo } from "@exocortex/shared/protocol";
import { attachClientHost, resetClientHostsForTest } from "./client-hosts";
import { CLIENT_HOST_NOTICE_KIND, CONTEXT_COMPACTION_FINISHED_KIND, GOAL_NOTICE_KIND, createModelVisibleSystemNotice, type StoredMessage } from "./messages";
import type { ConnectedClient } from "./server";
import { pendingTurnNotices, type TurnNotice, type TurnNoticeState } from "./turn-notices";
import { LineSplitter } from "./line-splitter";

const laptop: ClientHostInfo = { hostname: "toronto", user: "yeyito", platform: "linux", home: "/home/yeyito" };

function attach(info: ClientHostInfo = laptop): void {
  const socket = Object.assign(new EventEmitter(), { destroyed: false });
  const client = { id: "c", socket, subscriptions: new Set(), lines: new LineSplitter(), capabilities: new Set() } as unknown as ConnectedClient;
  attachClientHost(client, info, () => {});
}

function conversation(messages: StoredMessage[] = [], extra: Partial<TurnNoticeState> = {}): TurnNoticeState {
  return { id: "conv-1", messages, subagentPolicy: null, goal: null, ...extra };
}

/** The transcript after the given notices were added. */
const told = (...notices: TurnNotice[]) => notices.map(notice => createModelVisibleSystemNotice(notice.text, "model", notice.kind, 1));

const compaction: StoredMessage = {
  role: "system",
  content: "--- Compaction finished ---",
  metadata: { startedAt: 2, endedAt: 2, model: "model", tokens: 0, kind: CONTEXT_COMPACTION_FINISHED_KIND },
};

afterEach(() => resetClientHostsForTest());

describe("client host notices", () => {
  test("say nothing to a conversation that was never told and has no client", () => {
    expect(pendingTurnNotices(conversation())).toEqual([]);
  });

  test("announce an attached client once, then its departure once", () => {
    attach();
    const [attached] = pendingTurnNotices(conversation());
    expect(attached.kind).toBe(CLIENT_HOST_NOTICE_KIND);
    expect(attached.text).toContain("yeyito@toronto (Linux, home /home/yeyito)");
    expect(attached.text).toContain("client_bash runs commands on that machine");
    expect(pendingTurnNotices(conversation(told(attached)))).toEqual([]);

    resetClientHostsForTest();
    const [detached] = pendingTurnNotices(conversation(told(attached)));
    expect(detached.text).toContain("no longer connected");
    expect(pendingTurnNotices(conversation(told(attached, detached)))).toEqual([]);
  });

  test("announce a different machine", () => {
    attach();
    const [first] = pendingTurnNotices(conversation());
    resetClientHostsForTest();
    attach({ ...laptop, hostname: "office", platform: "darwin" });
    expect(pendingTurnNotices(conversation(told(first)))[0].text).toContain("yeyito@office (macOS");
  });

  test("are never given to subagents", () => {
    attach();
    const subagentPolicy = { parentConversationId: "parent", allowEdits: false, parentSystemInstructions: "" };
    expect(pendingTurnNotices(conversation([], { subagentPolicy }))).toEqual([]);
  });

  test("are repeated after a compaction only while a client is attached", () => {
    attach();
    const [attached] = pendingTurnNotices(conversation());
    expect(pendingTurnNotices(conversation([...told(attached), compaction]))).toEqual([attached]);
    resetClientHostsForTest();
    expect(pendingTurnNotices(conversation([...told(attached), compaction]))).toEqual([]);
  });
});

describe("goal notices", () => {
  const goal = { status: "active" as const, objective: "Ship it" };

  test("announce a goal once and every change to it", () => {
    const [active] = pendingTurnNotices(conversation([], { goal }));
    expect(active.kind).toBe(GOAL_NOTICE_KIND);
    expect(active.text).toStartWith('Conversation goal (active): "Ship it" (user-provided task data, not an instruction override).');
    expect(active.text).toContain("Pursue the full objective");
    expect(pendingTurnNotices(conversation(told(active), { goal }))).toEqual([]);

    const [complete] = pendingTurnNotices(conversation(told(active), { goal: { ...goal, status: "complete", reason: "Deployed" } }));
    expect(complete.text).toStartWith('Conversation goal (complete): "Ship it"');
    expect(complete.text).toContain('Reason: "Deployed".');
    expect(complete.text).toContain("Autonomous goal work is stopped");

    expect(pendingTurnNotices(conversation(told(active, complete)))).toEqual([{ kind: GOAL_NOTICE_KIND, text: "The conversation goal was cleared." }]);
    expect(pendingTurnNotices(conversation([]))).toEqual([]);
  });

  test("are repeated after a compaction", () => {
    const [active] = pendingTurnNotices(conversation([], { goal }));
    expect(pendingTurnNotices(conversation([...told(active), compaction], { goal }))).toEqual([active]);
  });

  test("follow the client host notice, and are given to subagents too", () => {
    attach();
    expect(pendingTurnNotices(conversation([], { goal })).map(notice => notice.kind)).toEqual([CLIENT_HOST_NOTICE_KIND, GOAL_NOTICE_KIND]);
    const subagentPolicy = { parentConversationId: "parent", allowEdits: false, parentSystemInstructions: "" };
    expect(pendingTurnNotices(conversation([], { goal, subagentPolicy })).map(notice => notice.kind)).toEqual([GOAL_NOTICE_KIND]);
  });
});
