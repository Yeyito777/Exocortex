import { readFileSync, statSync } from "fs";
import { join } from "path";
import { conversationsDir } from "../../shared/src/paths";
import { loadFromDisk, getRenderSnapshot, get, getQueuedMessages } from "../../daemon/src/conversations";

const ids = [
  ["galaxy tab a9 linux", "1779235042748-uplq5r"],
  ["lenovo m10 improve run", "1779400837687-nks3q1"],
  ["lenovo m10 linux install", "1778547786295-1ofps0"],
] as const;
const runs = Number(process.env.RUNS ?? "20");
const recentImagePayloadEntries = Number(process.env.RECENT_IMAGE_PAYLOAD_ENTRIES ?? "8");

function med(xs: number[]) { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
function p95(xs: number[]) { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(s.length * .95) - 1)]; }
function time<T>(fn: () => T): [T, number] { const t = performance.now(); const v = fn(); return [v, performance.now() - t]; }
function compactOldImages(data: any): any {
  return {
    ...data,
    entries: data.entries.map((entry: any, index: number) => entry.type === "user"
      && entry.images?.length
      && index < data.entries.length - recentImagePayloadEntries
      ? { ...entry, images: entry.images.map((img: any) => ({ mediaType: img.mediaType, base64: "", sizeBytes: img.sizeBytes })) }
      : entry),
  };
}

function eventFor(data: any, conv: any): Record<string, unknown> {
  const queued = getQueuedMessages(data.convId);
  return {
    type: "conversation_loaded",
    reqId: "bench",
    convId: data.convId,
    provider: data.provider,
    model: data.model,
    effort: data.effort,
    fastMode: data.fastMode,
    entries: data.entries,
    ...(data.pendingAI ? { pendingAI: data.pendingAI } : {}),
    contextTokens: data.contextTokens,
    toolOutputsIncluded: data.toolOutputsIncluded,
    queuedMessages: queued.length > 0 ? queued : undefined,
    goal: conv.goal ?? null,
  };
}

loadFromDisk();
const result: any = { runs, recentImagePayloadEntries, generatedAt: new Date().toISOString(), conversations: [] };
for (const [title, id] of ids) {
  const path = join(conversationsDir(), `${id}.json`);
  const fileBytes = statSync(path).size;
  const readMs: number[] = [];
  const parseMs: number[] = [];
  for (let i = 0; i < runs; i++) {
    let raw = "";
    [, readMs[i]] = time(() => { raw = readFileSync(path, "utf8"); });
    [, parseMs[i]] = time(() => JSON.parse(raw));
  }

  const conv = get(id)!;
  const messages = conv.messages.length;
  const imageChars = conv.messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
    .filter((b: any) => b.type === "image")
    .reduce((sum: number, b: any) => sum + (b.source?.data?.length ?? 0), 0);
  const toolResultChars = conv.messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
    .filter((b: any) => b.type === "tool_result")
    .reduce((sum: number, b: any) => sum + (typeof b.content === "string" ? b.content.length : JSON.stringify(b.content).length), 0);

  const snapshots: any = {};
  for (const include of [true, false]) {
    const snapMs: number[] = [];
    const stringifyFullMs: number[] = [];
    const stringifyCompactMs: number[] = [];
    const fullPayloadBytes: number[] = [];
    const compactPayloadBytes: number[] = [];
    const entries: number[] = [];
    const blocks: number[] = [];
    for (let i = 0; i < runs; i++) {
      let snap: any;
      [, snapMs[i]] = time(() => { snap = getRenderSnapshot(id, include); });
      const fullEvent = eventFor(snap, conv);
      const compactEvent = eventFor(compactOldImages(snap), conv);
      let fullJson = "";
      let compactJson = "";
      [, stringifyFullMs[i]] = time(() => { fullJson = JSON.stringify(fullEvent) + "\n"; });
      [, stringifyCompactMs[i]] = time(() => { compactJson = JSON.stringify(compactEvent) + "\n"; });
      fullPayloadBytes[i] = Buffer.byteLength(fullJson);
      compactPayloadBytes[i] = Buffer.byteLength(compactJson);
      entries[i] = snap.entries.length;
      blocks[i] = snap.entries.reduce((n: number, e: any) => n + (Array.isArray(e.blocks) ? e.blocks.length : 1), 0);
    }
    snapshots[String(include)] = {
      includeToolOutputs: include,
      entries: entries[0],
      blocks: blocks[0],
      fullPayloadBytes: fullPayloadBytes[0],
      fullPayloadMiB: fullPayloadBytes[0] / 1024 / 1024,
      compactPayloadBytes: compactPayloadBytes[0],
      compactPayloadMiB: compactPayloadBytes[0] / 1024 / 1024,
      snapshotMsMedian: med(snapMs), snapshotMsP95: p95(snapMs),
      stringifyFullMsMedian: med(stringifyFullMs), stringifyFullMsP95: p95(stringifyFullMs),
      stringifyCompactMsMedian: med(stringifyCompactMs), stringifyCompactMsP95: p95(stringifyCompactMs),
    };
  }
  result.conversations.push({
    title, id, fileBytes, fileMiB: fileBytes / 1024 / 1024, messages,
    imageChars, imageMiB: imageChars / 1024 / 1024,
    toolResultChars, toolResultMiB: toolResultChars / 1024 / 1024,
    diskReadMsMedian: med(readMs), diskReadMsP95: p95(readMs),
    jsonParseMsMedian: med(parseMs), jsonParseMsP95: p95(parseMs),
    snapshots,
  });
}
console.log(JSON.stringify(result, null, 2));
