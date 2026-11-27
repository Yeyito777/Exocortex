import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { create, createFolder, deleteFolder, ensureTopLevelFolder, getDisplayData, remove } from "./conversations";
import { load as loadPersisted } from "./persistence";
import { orchestrateSendMessage, type OrchestrationCallbacks } from "./orchestrator";
import type { streamMessage } from "./api";
import { FOLDER_AGENTS_NOTICE_KIND, SUBAGENTS_FOLDER_NAME, type ApiMessage } from "./messages";

const IDS: string[] = [];
const FOLDERS: string[] = [];

function id(suffix: string): string {
  const value = `folder-agents-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  IDS.push(value);
  return value;
}

function folder(name: string): string {
  const created = createFolder(`${name}-${Math.random().toString(36).slice(2, 8)}`)!;
  FOLDERS.push(created.id);
  return created.id;
}

function server() {
  return {
    sendTo: () => {},
    broadcast: () => {},
    sendToSubscribers: () => {},
    sendToSubscribersExcept: () => {},
    subscribe: () => {},
    unsubscribe: () => {},
    hasSubscribers: () => false,
    hasLegacyHistorySubscribers: () => false,
    sendHistoryUpdatedToSubscribers: () => {},
  };
}

/** A provider that answers "ok" and records the history each request carried. */
function recordingStream(requests: ApiMessage[][]): OrchestrationCallbacks {
  const streamMessageFn = (async (_provider: unknown, messages: ApiMessage[]) => {
    requests.push(messages.map(message => ({ ...message })));
    return {
      text: "ok", thinking: "", stopReason: "stop" as const,
      blocks: [{ type: "text" as const, text: "ok" }], toolCalls: [],
      inputTokens: 1, outputTokens: 1,
    };
  }) as unknown as typeof streamMessage;
  return { onHeaders() {}, onComplete() {}, streamMessageFn };
}

async function send(convId: string, text: string, requests: ApiMessage[][] = []): Promise<void> {
  const outcome = await orchestrateSendMessage(server() as never, null, undefined, convId, text, Date.now(), recordingStream(requests));
  expect(outcome.ok).toBe(true);
}

function notices(convId: string): string[] {
  return loadPersisted(convId)!.messages
    .filter(message => message.metadata?.kind === FOLDER_AGENTS_NOTICE_KIND)
    .map(message => message.content as string);
}

function text(message: ApiMessage): string {
  return typeof message.content === "string" ? message.content : message.content.map(block => block.type === "text" ? block.text : "").join("");
}

afterEach(() => {
  setSystemTime();
  for (const convId of IDS.splice(0)) remove(convId);
  for (const folderId of FOLDERS.splice(0)) deleteFolder(folderId, "unwrap", false);
});

describe("agents working in the same folder", () => {
  test("the first message gets the block, the model sees it before the message, and history keeps it", async () => {
    const project = folder("proj");
    const peer = id("peer");
    create(peer, "openai", "gpt-5.6-sol", "Peer work", undefined, false, project);
    const convId = id("me");
    create(convId, "openai", "gpt-5.6-sol", "Me", undefined, false, project);
    const requests: ApiMessage[][] = [];

    await send(convId, "hello", requests);

    const expected = `[info] There are other agents working in this project: {${peer}: Peer work}`;
    const stored = loadPersisted(convId)!.messages;
    expect(stored[0]).toMatchObject({
      role: "user", content: expected,
      metadata: { system: true, kind: FOLDER_AGENTS_NOTICE_KIND, folderAgents: [{ id: peer, title: "Peer work" }] },
    });
    expect(stored[1]).toMatchObject({ role: "user", content: "hello" });
    // What the provider got: the block, then the user's own message.
    const history = requests[0]!.map(text);
    expect(history.indexOf(expected)).toBeGreaterThanOrEqual(0);
    expect(history.indexOf(expected)).toBeLessThan(history.indexOf("hello"));
    // The display keeps it apart from the user's words: a notice clients fold away.
    const entries = getDisplayData(convId)!.entries;
    expect(entries.filter(entry => entry.type === "user").map(entry => entry.text)).toEqual(["hello"]);
    expect(entries).toContainEqual(expect.objectContaining({ type: "system", text: expected, metadata: expect.objectContaining({ kind: FOLDER_AGENTS_NOTICE_KIND }) }));
  });

  test("nothing more while the set is unchanged, then who joined and who finished", async () => {
    const project = folder("proj");
    const peer = id("peer");
    create(peer, "openai", "gpt-5.6-sol", "Peer work", undefined, false, project);
    const convId = id("me");
    create(convId, "openai", "gpt-5.6-sol", "Me", undefined, false, project);

    await send(convId, "first");
    await send(convId, "second");
    expect(notices(convId)).toHaveLength(1);

    const joiner = id("joiner");
    create(joiner, "openai", "gpt-5.6-sol", "Joiner", undefined, false, project);
    await send(convId, "third");
    expect(notices(convId).at(-1)).toBe(`[info] The other agents working in this project changed. Joined: {${joiner}: Joiner}.`);

    // Past the working window nobody else has done anything.
    setSystemTime(new Date(Date.now() + 31 * 60_000));
    await send(convId, "fourth");
    const finished = [peer, joiner].sort().map(agent => `${agent}: ${agent === peer ? "Peer work" : "Joiner"}`).join(", ");
    expect(notices(convId).at(-1)).toBe(`[info] The other agents working in this project changed. Finished: {${finished}}. No other agents are working in this project now.`);
    await send(convId, "fifth");
    expect(notices(convId)).toHaveLength(3);
  });

  test("catch-all places say nothing: the top level and the default subagents folder", async () => {
    const topPeer = id("top-peer");
    create(topPeer, "openai", "gpt-5.6-sol", "Top peer");
    const top = id("top");
    create(top, "openai", "gpt-5.6-sol", "Top");
    await send(top, "hello");
    expect(notices(top)).toEqual([]);

    const subagents = ensureTopLevelFolder(SUBAGENTS_FOLDER_NAME)!.id;
    const subPeer = id("sub-peer");
    create(subPeer, "openai", "gpt-5.6-sol", "Sub peer", undefined, false, subagents);
    const sub = id("sub");
    create(sub, "openai", "gpt-5.6-sol", "Sub", undefined, false, subagents);
    await send(sub, "hello");
    expect(notices(sub)).toEqual([]);
  });
});
