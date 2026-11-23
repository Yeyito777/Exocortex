#!/usr/bin/env bun
/**
 * Paid, worktree-only: one conversation through Claude, GPT, Gemini and back
 * (docs/model-switching.md). Each model runs a shell command that reads a code
 * only that turn's file holds and answers a question that needs every earlier
 * model's turns: the first message's image, and the codes earlier tool calls
 * read. `--restart` then has Gemini read one more code, waits while you
 * restart the test daemon (`scripts/dev/testd stop|start <worktree>`), and
 * asks Claude for it. `--checkpoint` instead runs a GPT turn, compacts the
 * conversation (an OpenAI-native checkpoint) and asks Claude about it.
 * `--api` runs Claude, DeepSeek, OpenRouter and Claude (API-key providers).
 * `--gemini-first` runs Gemini, GPT and DeepSeek.
 *
 *   scripts/dev/testd start <worktree>
 *   bun scripts/dev/model-switch-e2e.ts --live [--restart] [--keep]
 */
import assert from "node:assert/strict";
import net from "node:net";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { socketPath, worktreeName } from "../../shared/src/paths";
import type { Command } from "../../shared/src/protocol";

assert(worktreeName(), "Run from a worktree, never main.");
assert(process.argv.includes("--live"), "Use --live to authorize the short paid turns.");
const restart = process.argv.includes("--restart");
const keep = process.argv.includes("--keep");
const checkpoint = process.argv.includes("--checkpoint");
const api = process.argv.includes("--api");
const geminiFirst = process.argv.includes("--gemini-first");

const CLAUDE = { provider: "anthropic", model: process.env.E2E_CLAUDE ?? "claude-haiku-5-5", effort: "low" } as const;
const GPT = { provider: "openai", model: process.env.E2E_GPT ?? "gpt-6-luna", effort: "low" } as const;
const DEEPSEEK = { provider: "deepseek", model: process.env.E2E_DEEPSEEK ?? "deepseek-v4-flash", effort: "none" } as const;
const OPENROUTER = { provider: "openrouter", model: process.env.E2E_OPENROUTER ?? "nousresearch/hermes-4-405b", effort: "none" } as const;
const GEMINI = { provider: "gemini", model: process.env.E2E_GEMINI ?? "gemini-4-neon", effort: "low" } as const;

// Solid-colour PNGs: each model is asked the colour of an image no earlier
// answer named, which only the image itself shows.
function solidPng(color: readonly number[], size = 32): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) for (let c = 0; c < 3; c++) row[1 + x * 3 + c] = color[c];
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

const PALETTE = [["red", [230, 20, 20]], ["green", [20, 200, 40]], ["blue", [20, 40, 230]], ["yellow", [240, 230, 20]]] as const;
const quadrants = [...PALETTE].sort(() => Math.random() - 0.5);
const [first, second, third, fourth] = quadrants.map(([name]) => name);
const code = () => `${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`;
const codes = [code(), code(), code(), code()];
const dir = join("/tmp", `model-switch-e2e-${Date.now()}`);
mkdirSync(dir, { recursive: true });
codes.forEach((value, i) => writeFileSync(join(dir, `code${i + 1}.txt`), `${value}\n`));

const sock = socketPath();
let socket: net.Socket;
let buffer = "", serial = 0;
const pending = new Map<string, (event: any) => void>();
const observers = new Map<string, (event: any) => void>();
const texts = new Map<string, string>();
const compactionDone = new Map<string, (event: any) => void>();
async function connect(): Promise<void> {
  for (let i = 0; i < 300 && !existsSync(sock); i++) await Bun.sleep(200);
  socket = net.connect(sock);
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  socket.on("data", chunk => {
    buffer += String(chunk);
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const event = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      const request = pending.get(event.reqId);
      if (request) { pending.delete(event.reqId); request(event); }
      if (event.type === "text_chunk" && event.convId) texts.set(event.convId, (texts.get(event.convId) ?? "") + event.text);
      if (event.type === "context_compaction_status" && event.active === false) compactionDone.get(event.convId)?.(event);
      const observer = observers.get(event.convId);
      if (observer && (event.type === "message_complete" || event.type === "streaming_stopped" || event.type === "error")) observer(event);
    }
  });
}
function request(command: Command): Promise<any> {
  const reqId = `switch-${Date.now()}-${++serial}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(reqId); reject(new Error(`IPC timeout ${command.type}; inspect before retrying`)); }, 30_000);
    pending.set(reqId, event => { clearTimeout(timeout); resolve(event); });
    socket.write(JSON.stringify({ ...command, reqId }) + "\n");
  });
}

type Selection = { provider: string; model: string; effort: string };
async function turn(convId: string, selection: Selection, text: string, images?: unknown[]): Promise<string> {
  const switched = await request({ type: "set_model", convId, provider: selection.provider, model: selection.model, effort: selection.effort } as Command);
  assert.equal(switched.type, "ack", JSON.stringify(switched));
  texts.set(convId, "");
  let resolve!: (event: any) => void;
  const done = new Promise<any>(r => { resolve = r; });
  observers.set(convId, resolve);
  const started = Date.now();
  const accepted = await request({ type: "send_message", convId, startedAt: Date.now(), detached: true, text, ...(images ? { images } : {}) } as Command);
  assert.notEqual(accepted.type, "error", JSON.stringify(accepted));
  let timer: ReturnType<typeof setTimeout>;
  const completed = await Promise.race([done, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Turn wait expired; inspect ${convId}, do not retry submission`)), 300_000);
  })]).finally(() => clearTimeout(timer));
  observers.delete(convId);
  assert.equal(completed.type, "message_complete", JSON.stringify(completed).slice(0, 2000));
  const answer = texts.get(convId) ?? "";
  console.log(`\n── ${selection.provider}/${selection.model} (${((Date.now() - started) / 1000).toFixed(0)} s)\n${answer.trim()}`);
  return answer;
}

function expectAll(answer: string, wanted: string[], label: string): void {
  const missing = wanted.filter(value => !answer.toLowerCase().includes(value.toLowerCase()));
  assert.equal(missing.length, 0, `${label} did not mention ${missing.join(", ")}`);
}

await connect();
const convId = `${Date.now()}-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
const created = await request({ type: "new_conversation", convId, provider: (checkpoint ? GPT : geminiFirst ? GEMINI : CLAUDE).provider, model: (checkpoint ? GPT : geminiFirst ? GEMINI : CLAUDE).model, effort: "low", title: "Model switch e2e" } as Command);
assert.equal(created.type, "conversation_created", JSON.stringify(created));
await request({ type: "subscribe", convId } as Command);
console.log(`conversation ${convId}, files in ${dir}, images ${quadrants.map(([name]) => name).join(" ")}, codes ${codes.join(" ")}`);

const images = quadrants.map(([, rgb]) => { const base64 = solidPng(rgb); return { mediaType: "image/png", base64, sizeBytes: Buffer.from(base64, "base64").length }; });
async function compact(convId: string): Promise<void> {
  let resolve!: (event: any) => void;
  const done = new Promise<any>(r => { resolve = r; });
  compactionDone.set(convId, resolve);
  // No ack: it ends with its status event.
  socket.write(JSON.stringify({ type: "compact_conversation", convId, startedAt: Date.now() }) + "\n");
  const completed = await done;
  compactionDone.delete(convId);
  assert.ok(completed.completedAt, JSON.stringify(completed));
  // Let its turn wind down before the next command.
  await Bun.sleep(1000);
  console.log("\n── compacted");
}

const run = (n: number) => `Run the shell command \`cat ${join(dir, `code${n}.txt`)}\` with your shell tool.`;
try {
  if (checkpoint) {
    const c1 = await turn(convId, GPT, `${run(1)} Then reply with just the code it printed.`);
    expectAll(c1, [codes[0]], "GPT");
    await compact(convId);
    const c2 = await turn(convId, CLAUDE, "Without running anything, reply with just the code the command printed earlier in this conversation.");
    expectAll(c2, [codes[0]], "Claude (after GPT's checkpoint)");
    console.log("\nPASS: Claude read GPT's compacted history.");
  } else if (geminiFirst) {
    const g1 = await turn(convId, GEMINI, `${run(1)} Then reply with one line: the code it printed, and the colour of the first of the four attached images in one word.`, images);
    expectAll(g1, [codes[0], first], "Gemini");
    const g2 = await turn(convId, GPT, `${run(2)} Then reply with one line: the colour of the second of the four images from the start, the code from the first command, and the code this command printed.`);
    expectAll(g2, [second, codes[0], codes[1]], "GPT");
    const g3 = await turn(convId, DEEPSEEK, "Do not use any tools. Reply with one line: the codes the first and second commands printed, in order.");
    expectAll(g3, [codes[0], codes[1]], "DeepSeek");
    console.log("\nPASS: every model saw the earlier models' turns.");
  } else if (api) {
    const d1 = await turn(convId, CLAUDE, `${run(1)} Then reply with one line: the code it printed, and the colour of the first of the four attached images in one word.`, images);
    expectAll(d1, [codes[0], first], "Claude");
    const d2 = await turn(convId, DEEPSEEK, `${run(2)} Then reply with one line: the code from the first command earlier in this conversation, and the code this command printed.`);
    expectAll(d2, [codes[0], codes[1]], "DeepSeek");
    const d3 = await turn(convId, OPENROUTER, "Do not use any tools. Reply with one line: the codes the first and second shell commands in this conversation printed, in order.");
    expectAll(d3, [codes[0], codes[1]], "OpenRouter");
    const d4 = await turn(convId, CLAUDE, "Without running anything, reply with one line: the codes the first and second commands printed, and the colour of the second of the four images from the start.");
    expectAll(d4, [codes[0], codes[1], second], "Claude (back)");
    console.log("\nPASS: every model saw the earlier models' turns.");
  } else {
  const a1 = await turn(convId, CLAUDE, `${run(1)} Then reply with one line: the code it printed, and the colour of the first of the four attached images in one word.`, images);
  expectAll(a1, [codes[0], first], "Claude");

  const a2 = await turn(convId, GPT, `${run(2)} Then reply with one line: the colour of the second of the four images I sent at the start, the code from the first command earlier in this conversation, and the code this command printed.`);
  expectAll(a2, [second, codes[0], codes[1]], "GPT");

  const a3 = await turn(convId, GEMINI, `${run(3)} Then reply with one line: the colour of the third of the four images from the start, the code from the first command, the code from the second command, and the code this command printed.`);
  expectAll(a3, [third, codes[0], codes[1], codes[2]], "Gemini");

  const a4 = await turn(convId, CLAUDE, "Without running anything, reply with one line: the colour of the fourth of the four images from the start, and the codes from the first, second and third commands in this conversation, in order.");
  expectAll(a4, [fourth, codes[0], codes[1], codes[2]], "Claude (back)");

  if (restart) {
    const a5 = await turn(convId, GEMINI, `${run(4)} Then reply with just the code it printed.`);
    expectAll(a5, [codes[3]], "Gemini (before restart)");
    console.log(`\nRestart the test daemon now (scripts/dev/testd stop ${worktreeName()} && scripts/dev/testd start ${worktreeName()}); waiting for its socket to go and come back.`);
    socket.destroy();
    for (let i = 0; i < 900 && existsSync(sock); i++) await Bun.sleep(200);
    await connect();
    for (let i = 0; i < 100; i++) {
      const status = await request({ type: "subscribe", convId } as Command).catch(() => null);
      if (status && status.type !== "error") break;
      await Bun.sleep(300);
    }
    const a6 = await turn(convId, CLAUDE, "Without running anything, reply with one line: the code the most recent command printed, and the colour of the first image from the start.");
    expectAll(a6, [codes[3], first], "Claude (after restart)");
  }
  console.log("\nPASS: every model saw the earlier models' turns.");
  }
} finally {
  if (!keep) {
    socket.write(JSON.stringify({ type: "delete_conversation", convId }) + "\n");
    await Bun.sleep(500);
    console.log(`deleted test conversation ${convId}`);
  }
  socket.destroy();
}
