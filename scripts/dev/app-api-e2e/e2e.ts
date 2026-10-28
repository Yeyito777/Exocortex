// App API end-to-end check against a running test daemon (real model calls); run.sh sets it up.
// Env: SOCKET, WIRE_LOG, APP_CWD (dir with a canary CLAUDE.md), DATA_DIR / RUNTIME_DIR (the test
//      instance's), PHASE (main | after-restart), STATE (ids across phases), ONLY (anthropic|openai)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";
import { RawClient, type Json } from "./raw-client";

const SOCKET = process.env.SOCKET!;
const WIRE_LOG = process.env.WIRE_LOG!;
const APP_CWD = process.env.APP_CWD!;
const DATA_DIR = process.env.DATA_DIR!;
const STATE = process.env.STATE!;
const PHASE = process.env.PHASE ?? "main";
const GLOBAL_CANARY = "GLOBAL_CANARY_9431";
const CLAUDEMD_CANARY = "CLAUDEMD_CANARY_5512";
// Claude Code auto-memory (the user's own, under the git root's project) opens with this.
const MEMORY_CANARY = "persistent file-based memory";
const PROVIDERS = [
  { provider: "anthropic", model: "claude-haiku-5-5", effort: "low" },
  { provider: "openai", model: "gpt-5.4-mini", effort: "low" },
].filter(entry => !process.env.ONLY || entry.provider === process.env.ONLY);

let failures = 0;
function check(ok: boolean, label: string, detail?: unknown): void {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${!ok && detail !== undefined ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 800)}` : ""}`);
  if (!ok) failures++;
}

function wireSince(at: number): Json[] {
  if (!existsSync(WIRE_LOG)) return [];
  return readFileSync(WIRE_LOG, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Json).filter(entry => entry.at >= at);
}

/** The model requests of a conversation since `at`: those carrying its system marker. */
function requestsWith(marker: string, at: number): Json[] {
  return wireSince(at).filter(entry => JSON.stringify(entry.system ?? "").includes(marker));
}

const lookupTool = {
  name: "lookup",
  description: "Look up the meaning of an invented word. Always use this for words you do not know.",
  inputSchema: { type: "object", properties: { word: { type: "string" } }, required: ["word"] },
};

async function welcome(client: RawClient): Promise<void> {
  const answer = await client.request({ type: "client_capabilities", capabilities: [], app: { name: "e2e", version: "1.0" } }, ["app_welcome"], 10_000);
  check(answer.type === "app_welcome" && answer.appApiVersion === 1 && answer.app === "e2e", "app_welcome with appApiVersion 1", answer);
}

function answerLookups(client: RawClient, output = "zorp: a small blue frog that hums."): void {
  client.onEvent = (event) => {
    if (event.type === "app_tool_call" && event.name === "lookup") {
      client.send({ type: "app_tool_result", convId: event.convId, callId: event.callId, output });
    }
  };
}

async function sendAwait(client: RawClient, convId: string, text: string, timeoutMs = 180_000): Promise<Json> {
  return client.request({ type: "send_message", convId, text, startedAt: Date.now(), awaitResult: true }, ["turn_result"], timeoutMs);
}

function noCanaries(entries: Json[], label: string): void {
  const text = JSON.stringify(entries.map(entry => [entry.system, entry.input]));
  check(!text.includes(GLOBAL_CANARY), `${label}: no global instructions on the wire`);
  check(!text.includes(CLAUDEMD_CANARY), `${label}: no CLAUDE.md on the wire`);
  check(!text.includes(MEMORY_CANARY), `${label}: no memory on the wire`);
}

function convDiskTraces(convId: string): string[] {
  const traces: string[] = [];
  const db = new Database(join(DATA_DIR, "exocortex.sqlite3"), { readonly: true });
  try {
    for (const table of ["conversations"]) {
      const row = db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE id=?`).get(convId) as { n: number };
      if (row.n > 0) traces.push(`sqlite ${table}`);
    }
    for (const table of ["messages", "queued_messages", "display_entries"]) {
      const row = db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE conversation_id=?`).get(convId) as { n: number };
      if (row.n > 0) traces.push(`sqlite ${table}`);
    }
  } finally { db.close(); }
  if (existsSync(join(DATA_DIR, "workspaces", convId))) traces.push("workspace");
  const registry = join(DATA_DIR, "app-conversations.json");
  if (existsSync(registry) && readFileSync(registry, "utf8").includes(convId)) traces.push("app-conversations.json");
  const runtime = process.env.RUNTIME_DIR!;
  for (const name of ["live-turns.json", "anthropic-conversation-accounts.json"]) {
    const path = join(runtime, name);
    if (existsSync(path) && readFileSync(path, "utf8").includes(convId)) traces.push(name);
  }
  return traces;
}

async function mainPhase(): Promise<void> {
  const client = await RawClient.open(SOCKET);
  client.transcript = [];
  await welcome(client);
  const pong = await client.request({ type: "ping" }, ["pong"], 10_000);
  check(pong.type === "pong", "ping answers pong");
  await Bun.sleep(300);
  check(!client.events.some(event => event.type === "conversations_list" || event.type === "tools_available" || event.type === "usage_update"), "app client gets no TUI bootstrap or broadcasts");

  const tui = await RawClient.open(SOCKET);
  tui.send({ type: "client_capabilities", capabilities: [] });
  const state: Json = {};

  for (const { provider, model, effort } of PROVIDERS) {
    console.log(`\n== ${provider} (${model})`);
    answerLookups(client);

    // ── base none, ephemeral, one app tool
    const noneMarker = `E2E_NONE_${provider.toUpperCase()}`;
    let at = Date.now();
    const created = await client.request({
      type: "new_conversation", lifetime: "ephemeral", provider, model, effort,
      system: { base: "none", text: `${noneMarker}. You are a terse test bot. Answer word questions only by calling the lookup tool, then reply in one sentence.` },
      tools: { app: [lookupTool] },
    }, ["conversation_created"], 30_000);
    check(created.type === "conversation_created" && created.app?.lifetime === "ephemeral", "ephemeral app conversation created", created);
    const ephemeralId = created.convId as string;
    const ephemeralWorkspace = created.app?.workspace as string | undefined;
    check(typeof ephemeralWorkspace === "string" && existsSync(ephemeralWorkspace), "ephemeral working directory exists", created.app);
    const callsBefore = client.events.length;
    const result = await sendAwait(client, ephemeralId, "What does the word zorp mean?");
    const call = client.events.slice(callsBefore).find(event => event.type === "app_tool_call");
    check(call?.name === "lookup" && call.convId === ephemeralId, "app_tool_call reached the owner", call);
    check(result.type === "turn_result" && result.stopReason === "end_turn" && /frog/i.test(result.text), "turn_result end_turn with the tool's answer", result);
    check(typeof result.turnId === "string" && result.turnId.length > 0, "turn_result carries a turnId", result);
    const toolEvent = client.events.slice(callsBefore).find(event => event.type === "tool_call" && event.toolName === "lookup");
    check(toolEvent !== undefined, "tool_call event recorded under the bare name", client.events.slice(callsBefore).filter(e => e.type === "tool_call"));
    const noneRequests = requestsWith(noneMarker, at);
    check(noneRequests.length > 0, "base none: requests captured on the wire", wireSince(at).length);
    noCanaries(noneRequests, "base none");
    const noneTools = [...new Set(noneRequests.flatMap(entry => entry.tools as string[]))];
    const expectedNoneTools = provider === "anthropic" ? ["mcp__app__lookup"] : ["lookup"];
    check(JSON.stringify(noneTools.sort()) === JSON.stringify(expectedNoneTools), `base none: only the app tool on the wire (${expectedNoneTools})`, noneTools);
    if (provider === "anthropic") {
      const system = JSON.stringify(noneRequests[0]?.system);
      check(!system.includes("You are Claude Code") && !system.includes("# Internal tools"), "base none: no Claude Code preset or Exocortex header", system.slice(0, 600));
    } else {
      check(String(noneRequests[0]?.system).startsWith(noneMarker), "base none: instructions are exactly the app's text", String(noneRequests[0]?.system).slice(0, 300));
    }
    const listed = await tui.request({ type: "list_conversations" }, ["conversations_list"], 10_000);
    check(!(listed.conversations as Json[]).some(summary => summary.id === ephemeralId), "ephemeral conversation not in the TUI's conversations_list");
    check(!tui.events.some(event => JSON.stringify(event).includes(ephemeralId)), "TUI connection saw no event about the ephemeral conversation");
    check(convDiskTraces(ephemeralId).length === 0, "ephemeral conversation was never written to disk", convDiskTraces(ephemeralId));

    // ── base agent, built-in read only
    const agentMarker = `E2E_AGENT_${provider.toUpperCase()}`;
    at = Date.now();
    const agent = await client.request({
      type: "new_conversation", lifetime: "ephemeral", provider, model, effort, cwd: APP_CWD,
      system: { base: "agent", text: `${agentMarker}. Reply with one word.` },
      tools: { builtin: ["read"] },
    }, ["conversation_created"], 30_000);
    check(agent.type === "conversation_created", "agent-base conversation created (app cwd)", agent);
    const agentResult = await sendAwait(client, agent.convId, "Say hello.");
    check(agentResult.stopReason === "end_turn", "agent-base turn ended", agentResult);
    const agentRequests = requestsWith(agentMarker, at);
    check(agentRequests.length > 0, "base agent: requests captured", wireSince(at).length);
    noCanaries(agentRequests, "base agent");
    const agentTools = [...new Set(agentRequests.flatMap(entry => entry.tools as string[]))].sort();
    const expectedAgentTools = provider === "anthropic" ? ["Read"] : ["read", "view_image"];
    check(JSON.stringify(agentTools) === JSON.stringify(expectedAgentTools), `base agent: only the selected built-ins (${expectedAgentTools})`, agentTools);
    if (provider === "anthropic") {
      check(JSON.stringify(agentRequests[0]?.system).includes("Claude Code"), "base agent: Claude Code's own prompt is there", JSON.stringify(agentRequests[0]?.system).slice(0, 400));
      check(!agentTools.some(name => ["TodoWrite", "Task", "Agent", "Skill", "Bash", "Write"].includes(name)), "unselected Claude Code tools unavailable");
    } else {
      check(String(agentRequests[0]?.system).includes("Environment:") && String(agentRequests[0]?.system).includes("# Internal tools"), "base agent: environment header and tool hints", String(agentRequests[0]?.system).slice(0, 300));
    }
    // Ending: delete for good; the app cwd survives.
    const deleted = await client.request({ type: "delete_conversation", convId: agent.convId }, ["conversation_deleted"], 30_000);
    check(deleted.type === "conversation_deleted" && deleted.reason === "deleted", "delete_conversation answers conversation_deleted", deleted);
    check(existsSync(join(APP_CWD, "CLAUDE.md")), "deleting never touches the app cwd");

    // ── base full: sanity check that the canaries would be seen
    const fullMarker = `E2E_FULL_${provider.toUpperCase()}`;
    at = Date.now();
    const full = await client.request({
      type: "new_conversation", lifetime: "ephemeral", provider, model, effort, cwd: APP_CWD,
      system: { base: "full", text: `${fullMarker}. Reply with one word.` },
    }, ["conversation_created"], 30_000);
    await sendAwait(client, full.convId, "Say hi.");
    const fullRequests = requestsWith(fullMarker, at);
    const fullText = JSON.stringify(fullRequests.map(entry => [entry.system, entry.input]));
    check(fullText.includes(GLOBAL_CANARY), "base full: global instructions present (canary works)");
    if (provider === "anthropic") check(fullText.includes(CLAUDEMD_CANARY), "base full: CLAUDE.md present (canary works)");
    if (provider === "anthropic") check(fullText.includes(MEMORY_CANARY), "base full: auto-memory present (canary works)");
    await client.request({ type: "delete_conversation", convId: full.convId }, ["conversation_deleted"], 30_000);

    // ── ephemeral ends with its owner: nothing left
    const ownerClient = await RawClient.open(SOCKET);
    await welcome(ownerClient);
    const owned = await ownerClient.request({ type: "new_conversation", lifetime: "ephemeral", provider, model, effort, system: { text: "Reply with one word." } }, ["conversation_created"], 30_000);
    const ownedWorkspace = owned.app?.workspace as string;
    await sendAwait(ownerClient, owned.convId, "Say yes.");
    ownerClient.close();
    await Bun.sleep(1500);
    const afterClose = await client.request({ type: "list_app_conversations", includeSaved: true }, ["app_conversations_list"], 10_000);
    check(!(afterClose.conversations as Json[]).some(info => info.convId === owned.convId), "ephemeral ended when its owner disconnected");
    check(!existsSync(ownedWorkspace), "its temporary working directory is gone", ownedWorkspace);
    const projectDir = join(homedir(), ".claude", "projects", ownedWorkspace.replace(/[^a-zA-Z0-9]/g, "-"));
    check(!existsSync(projectDir), "its Claude Code project directory is gone (or never made)", projectDir);
    check(convDiskTraces(owned.convId).length === 0, "nothing of it on disk", convDiskTraces(owned.convId));

    // ── app_run one-shot
    at = Date.now();
    const runReq = client.reqId();
    const runSince = client.events.length;
    client.send({ type: "app_run", reqId: runReq, provider, model, effort, prompt: "What does zorp mean? Use lookup.", system: { text: "Use the lookup tool for unknown words; answer in one sentence." }, tools: { app: [lookupTool] } });
    const runCreated = await client.wait(event => event.reqId === runReq && (event.type === "conversation_created" || event.type === "error"), 30_000, runSince);
    const runResult = await client.wait(event => event.reqId === runReq && (event.type === "turn_result" || event.type === "error"), 180_000, runSince);
    check(runCreated.type === "conversation_created" && runResult.type === "turn_result" && /frog/i.test(runResult.text), "app_run: created, tool round trip, turn_result", runResult);
    const runDeleted = await client.wait(event => event.type === "conversation_deleted" && event.convId === runCreated.convId, 30_000, runSince);
    check(runDeleted.reason === "run_finished", "app_run: ephemeral deleted after the turn", runDeleted);
    const badRun = await client.request({ type: "app_run", prompt: "x", tools: { builtin: ["nope"] }, provider, model }, ["conversation_created", "turn_result"], 10_000);
    check(badRun.type === "error" && /nope/.test(badRun.message) && !client.events.some(event => event.reqId === badRun.reqId && event.type === "conversation_created"), "app_run validation error answers error first, naming the tool", badRun);
  }

  // ── Provider-specific refusals
  const noSearch = await client.request({ type: "new_conversation", provider: "openai", model: "gpt-5.4-mini", lifetime: "ephemeral", tools: { builtin: ["web_search"] } }, ["conversation_created"], 10_000);
  check(noSearch.type === "error" && /web_search/.test(noSearch.message), "web_search on openai is a create error naming it", noSearch);
  const ordinary = await tui.request({ type: "new_conversation", provider: "anthropic", lifetime: "temporary" }, ["conversation_created"], 10_000);
  check(ordinary.type === "error" && /app/.test(ordinary.message), "non-app connections cannot use app-only fields", ordinary);

  // ── App tool timeout and abort (anthropic, cheap)
  const p0 = PROVIDERS[0]!;
  client.onEvent = null;
  const slow = { ...lookupTool, timeoutMs: 3000 };
  const timeoutConv = await client.request({ type: "new_conversation", lifetime: "ephemeral", provider: p0.provider, model: p0.model, effort: p0.effort, system: { text: "Call lookup for every word question. If it fails, reply exactly: LOOKUP FAILED." }, tools: { app: [slow] } }, ["conversation_created"], 30_000);
  const tSince = client.events.length;
  const timedOut = await sendAwait(client, timeoutConv.convId, "What does zorp mean?");
  const cancel = client.events.slice(tSince).find(event => event.type === "app_tool_cancel");
  check(cancel?.reason === "timeout", "unanswered app tool call is cancelled with reason timeout", cancel);
  check(timedOut.stopReason === "end_turn", "the model got an error result and the turn ended", timedOut);
  const lateCall = client.events.slice(tSince).find(event => event.type === "app_tool_call");
  if (lateCall) client.send({ type: "app_tool_result", convId: lateCall.convId, callId: lateCall.callId, output: "late" });
  await Bun.sleep(300);
  check(!client.events.slice(tSince).some(event => event.type === "error"), "a late result is ignored silently");

  const abortSince = client.events.length;
  const abortReq = client.reqId();
  client.send({ type: "send_message", reqId: abortReq, convId: timeoutConv.convId, text: "What does blorp mean?", startedAt: Date.now(), awaitResult: true });
  const pendingCall = await client.wait(event => event.type === "app_tool_call", 120_000, abortSince);
  client.send({ type: "abort", convId: timeoutConv.convId });
  const aborted = await client.wait(event => event.reqId === abortReq && (event.type === "turn_result" || event.type === "error"), 60_000, abortSince);
  const abortCancel = await client.wait(event => event.type === "app_tool_cancel" && event.callId === pendingCall.callId, 10_000, abortSince).catch(() => null);
  check(aborted.type === "turn_result" && aborted.stopReason === "aborted", "abort during an app tool call: turn_result aborted", aborted);
  check(abortCancel?.reason === "aborted", "abort sends app_tool_cancel reason aborted", abortCancel);
  await client.request({ type: "delete_conversation", convId: timeoutConv.convId }, ["conversation_deleted"], 30_000);

  // ── Saved: filed under apps/e2e/, visible to the TUI, never unread
  const saved = await client.request({ type: "new_conversation", provider: p0.provider, model: p0.model, effort: p0.effort, title: "E2E saved", system: { text: "Reply with one word." } }, ["conversation_created"], 30_000);
  await sendAwait(client, saved.convId, "Say ok.");
  const tuiList = await tui.request({ type: "list_conversations" }, ["conversations_list"], 10_000);
  const savedRow = (tuiList.conversations as Json[]).find(row => row.id === saved.convId);
  const appFolder = (tuiList.folders as Json[]).find(folder => folder.id === savedRow?.folderId);
  const appsFolder = (tuiList.folders as Json[]).find(folder => folder.id === appFolder?.parentId);
  check(appFolder?.name === "e2e" && appsFolder?.name === "apps", "saved conversation is in apps/e2e/", { savedRow, appFolder, appsFolder });
  check(savedRow?.unread === false && savedRow?.title === "E2E saved", "saved app conversation: never unread, app's title", savedRow);
  state.savedId = saved.convId;

  // ── Temporary: hidden; one expiring, one kept across the restart, with a tool call pending
  const temp = await client.request({ type: "new_conversation", lifetime: "temporary", idleTtlMs: 4000, provider: p0.provider, model: p0.model, effort: p0.effort, system: { text: "x" } }, ["conversation_created"], 30_000);
  const tempList = await tui.request({ type: "list_conversations" }, ["conversations_list"], 10_000);
  check(!(tempList.conversations as Json[]).some(row => row.id === temp.convId), "temporary conversation hidden from the TUI");
  const loaded = await tui.request({ type: "load_conversation", convId: temp.convId }, ["conversation_loaded"], 10_000);
  check(loaded.type === "conversation_loaded", "hidden conversation can still be loaded by id", loaded.type);
  state.expiringId = temp.convId;
  state.expiringWorkspace = temp.app?.workspace;

  const kept = await client.request({ type: "new_conversation", lifetime: "temporary", provider: p0.provider, model: p0.model, effort: p0.effort, system: { text: "Use lookup for unknown words, then answer in one sentence." }, tools: { app: [lookupTool] } }, ["conversation_created"], 30_000);
  state.keptId = kept.convId;
  // Owner drops mid-call; a new connection attaches and answers.
  const keptSince = client.events.length;
  const keptTurn = String(Date.now());
  client.send({ type: "send_message", reqId: client.reqId(), convId: kept.convId, text: "What does zorp mean?", startedAt: Number(keptTurn), awaitResult: true });
  await client.wait(event => event.type === "app_tool_call" && event.convId === kept.convId, 120_000, keptSince);
  client.close();
  tui.close();
  await Bun.sleep(1500);
  const second = await RawClient.open(SOCKET);
  await welcome(second);
  answerLookups(second);
  const attachSince = second.events.length;
  const attached = await second.request({ type: "attach_app_conversation", convId: kept.convId }, ["app_conversation_attached"], 10_000);
  check(attached.type === "app_conversation_attached" && attached.conversation?.lifetime === "temporary", "attach_app_conversation answers", attached);
  const resent = await second.wait(event => event.type === "app_tool_call" && event.convId === kept.convId, 10_000, attachSince).catch(() => null);
  check(resent !== null, "the unanswered app tool call is sent again to the new owner");
  const ownerResult = await second.wait(event => event.type === "turn_result" && event.convId === kept.convId, 180_000, attachSince);
  check(ownerResult.turnId === keptTurn && !ownerResult.reqId && /frog/i.test(ownerResult.text), "new owner gets turn_result (convId only, same turnId)", ownerResult);
  second.close();
  state.keptTurn = keptTurn;
  writeFileSync(STATE, JSON.stringify(state));
  if (process.env.TRANSCRIPT_DIR) writeFileSync(join(process.env.TRANSCRIPT_DIR, "transcript.txt"), (client.transcript ?? []).join("\n"));
}

async function afterRestartPhase(): Promise<void> {
  const state = JSON.parse(readFileSync(STATE, "utf8")) as Json;
  const client = await RawClient.open(SOCKET);
  await welcome(client);
  const list = await client.request({ type: "list_app_conversations", includeSaved: true }, ["app_conversations_list"], 10_000);
  const ids = (list.conversations as Json[]).map(info => info.convId);
  check(!ids.includes(state.expiringId), "expired temporary conversation deleted (startup sweep)", ids);
  check(convDiskTraces(state.expiringId).length === 0, "expired one left nothing in the store", convDiskTraces(state.expiringId));
  if (state.expiringWorkspace) check(!existsSync(state.expiringWorkspace), "expired one's workspace removed", state.expiringWorkspace);
  check(ids.includes(state.keptId), "other temporary conversation survived the restart");
  check(ids.includes(state.savedId), "saved conversation survived the restart");
  const attached = await client.request({ type: "attach_app_conversation", convId: state.keptId }, ["app_conversation_attached"], 10_000);
  check(attached.lastTurnResult?.turnId === state.keptTurn && /frog/i.test(attached.lastTurnResult?.text ?? ""), "attach after restart carries lastTurnResult", attached.lastTurnResult);
  for (const convId of [state.keptId, state.savedId]) {
    const deleted = await client.request({ type: "delete_conversation", convId }, ["conversation_deleted"], 30_000);
    check(deleted.type === "conversation_deleted", `deleted ${convId}`, deleted);
    check(convDiskTraces(convId).length === 0, `nothing of ${convId} left in the store`, convDiskTraces(convId));
  }
  client.close();
}

const run = PHASE === "after-restart" ? afterRestartPhase : mainPhase;
const watchdog = setTimeout(() => { console.log("FAIL: e2e watchdog (15 min)"); process.exit(2); }, 15 * 60_000);
run().then(() => {
  clearTimeout(watchdog);
  console.log(`\n${failures === 0 ? "ALL OK" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}).catch(error => {
  console.log(`FAIL: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(2);
});
