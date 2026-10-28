// A turn interrupted by a daemon restart while an app tool call waits; after the
// restart the turn is replayed, a new connection attaches and answers, and gets
// the turn_result with the same turnId. PHASE=before|after, STATE=file.
import { readFileSync, writeFileSync } from "node:fs";
import { RawClient, type Json } from "./raw-client";

const SOCKET = process.env.SOCKET!;
const STATE = process.env.STATE!;
const lookupTool = { name: "lookup", description: "Look up the meaning of an invented word. Always use it for unknown words.", inputSchema: { type: "object", properties: { word: { type: "string" } }, required: ["word"] } };
const PROVIDERS = [
  { provider: "anthropic", model: "claude-haiku-5-5", effort: "low" },
  { provider: "openai", model: "gpt-5.4-mini", effort: "low" },
];
let failures = 0;
const check = (ok: boolean, label: string, detail?: unknown) => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${!ok && detail !== undefined ? `: ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
  if (!ok) failures++;
};

async function before(): Promise<void> {
  const client = await RawClient.open(SOCKET);
  await client.request({ type: "client_capabilities", capabilities: [], app: { name: "e2e" } }, ["app_welcome"], 5000);
  const state: Json[] = [];
  for (const { provider, model, effort } of PROVIDERS) {
    const created = await client.request({ type: "new_conversation", lifetime: "temporary", provider, model, effort, system: { text: "Use the lookup tool for unknown words, then answer in one sentence." }, tools: { app: [lookupTool] } }, ["conversation_created"], 30_000);
    const startedAt = Date.now();
    const since = client.events.length;
    client.send({ type: "send_message", reqId: client.reqId(), convId: created.convId, text: "What does the word zorp mean?", startedAt, awaitResult: true });
    const call = await client.wait(event => event.type === "app_tool_call" && event.convId === created.convId, 120_000, since);
    check(call.name === "lookup", `${provider}: tool call pending before the restart`);
    state.push({ provider, convId: created.convId, turnId: String(startedAt) });
  }
  writeFileSync(STATE, JSON.stringify(state));
  client.send({ type: "restart_daemon", reqId: client.reqId() });
  await client.wait(event => event.type === "daemon_shutdown", 30_000).catch(() => null);
  console.log("restart requested");
}

async function after(): Promise<void> {
  const state = JSON.parse(readFileSync(STATE, "utf8")) as Json[];
  const client = await RawClient.open(SOCKET);
  await client.request({ type: "client_capabilities", capabilities: [], app: { name: "e2e" } }, ["app_welcome"], 5000);
  client.onEvent = event => {
    if (event.type === "app_tool_call") client.send({ type: "app_tool_result", convId: event.convId, callId: event.callId, output: "zorp: a small blue frog that hums." });
  };
  for (const entry of state) {
    const attached = await client.request({ type: "attach_app_conversation", convId: entry.convId }, ["app_conversation_attached"], 10_000);
    check(attached.type === "app_conversation_attached", `${entry.provider}: re-attached after the restart (streaming=${attached.conversation?.streaming})`, attached);
  }
  for (const entry of state) {
    const result = await client.wait(event => event.type === "turn_result" && event.convId === entry.convId, 240_000)
      .catch(() => client.request({ type: "attach_app_conversation", convId: entry.convId }, ["app_conversation_attached"], 10_000).then(answer => ({ fromAttach: answer.lastTurnResult })));
    const turn = (result as Json).fromAttach ?? result;
    check(turn?.turnId === entry.turnId && turn?.stopReason === "end_turn" && /frog/i.test(turn?.text ?? ""), `${entry.provider}: replayed turn resolved with the same turnId`, result);
    await client.request({ type: "delete_conversation", convId: entry.convId }, ["conversation_deleted"], 30_000);
  }
  client.close();
}

const watchdog = setTimeout(() => { console.log("FAIL: watchdog"); process.exit(2); }, 10 * 60_000);
(process.env.PHASE === "after" ? after : before)().then(() => {
  clearTimeout(watchdog);
  console.log(failures === 0 ? "ALL OK" : `${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}).catch(error => { console.log(`FAIL: ${error instanceof Error ? error.stack : error}`); process.exit(2); });
