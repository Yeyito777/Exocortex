import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { arch, platform, release } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const OPENAI_ORIGINATOR = "codex_cli_rs";
const OPENAI_CODEX_CLIENT_VERSION = process.env.OPENAI_CODEX_CLIENT_VERSION?.trim() || "0.99.0";
const CHATGPT_BASE_URL = (process.env.OPENAI_CHATGPT_BASE_URL?.trim() || "https://chatgpt.com").replace(/\/+$/, "");
const OPENAI_CODEX_RESPONSES_URL = `${CHATGPT_BASE_URL}/backend-api/codex/responses`;
const OPENAI_IMAGE_GENERATION_MODEL = "gpt-5.4-mini";
const IMAGE_GENERATION_INSTRUCTIONS = "Call the image generation tool EXACTLY according to the user's request. No interpretation no adding things copy the user request word for word.";
const IMAGE_GENERATION_STALL_TIMEOUT_MS = 180_000;
const OPENAI_USER_AGENT = `${OPENAI_ORIGINATOR}/${OPENAI_CODEX_CLIENT_VERSION} (${platform()} ${release()}; ${arch()}) exocortex-image-cli/openai`;
const OPENAI_AUTH_ARG = "--exocortex-auth-openai";

interface OpenAIAuthPayload {
  provider?: unknown;
  accessToken?: unknown;
  accountId?: unknown;
}

interface OpenAIImageGenerationResponseItem {
  type?: unknown;
  id?: unknown;
  status?: unknown;
  revised_prompt?: unknown;
  result?: unknown;
}

interface OpenAIImageGenerationResponse {
  output?: unknown;
}

interface OpenAIImageGenerationSession {
  accessToken: string;
  accountId: string | null;
}

interface OpenAIGeneratedImage {
  id: string | null;
  status: string | null;
  revisedPrompt: string | null;
  base64: string;
}

function usage(): string {
  return `usage: image <command> [args]\n\ncommands:\n  generate [--json] [--out <path>] <prompt>   Generate an image and print the saved path\n  help, -h, --help                            Show this help\n\nThis tool expects daemon-provided OpenAI auth (${OPENAI_AUTH_ARG}).`;
}

function die(message: string, code = 1): never {
  console.error(`image: ${message}`);
  process.exit(code);
}

function decodeOpenAIAuth(encoded: string | undefined): OpenAIImageGenerationSession {
  if (!encoded) die(`missing ${OPENAI_AUTH_ARG}; run this tool through Exocortex so the daemon can lend OpenAI auth`);
  let parsed: OpenAIAuthPayload;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as OpenAIAuthPayload;
  } catch (err) {
    die(`invalid ${OPENAI_AUTH_ARG}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed.provider !== "openai" || typeof parsed.accessToken !== "string" || parsed.accessToken.length === 0) {
    die(`invalid ${OPENAI_AUTH_ARG}: expected OpenAI access token payload`);
  }
  return {
    accessToken: parsed.accessToken,
    accountId: typeof parsed.accountId === "string" && parsed.accountId.length > 0 ? parsed.accountId : null,
  };
}

function parseGlobalArgs(argv: string[]): { encodedAuth: string | undefined; rest: string[] } {
  const rest: string[] = [];
  let encodedAuth: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === OPENAI_AUTH_ARG) {
      encodedAuth = argv[++i];
      if (!encodedAuth) die(`${OPENAI_AUTH_ARG} requires a value`);
      continue;
    }
    if (arg.startsWith(`${OPENAI_AUTH_ARG}=`)) {
      encodedAuth = arg.slice(OPENAI_AUTH_ARG.length + 1);
      continue;
    }
    rest.push(arg);
  }
  return { encodedAuth, rest };
}

function parseGenerateArgs(args: string[]): { prompt: string; json: boolean; outPath: string | null } {
  const promptParts: string[] = [];
  let json = false;
  let outPath: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--out") {
      outPath = args[++i] ?? null;
      if (!outPath) die("--out requires a path");
    } else if (arg.startsWith("--out=")) {
      outPath = arg.slice("--out=".length);
      if (!outPath) die("--out requires a path");
    } else if (arg === "-h" || arg === "--help") {
      console.log(usage());
      process.exit(0);
    } else {
      promptParts.push(arg);
    }
  }
  const prompt = promptParts.join(" ").trim();
  if (!prompt) die("generate requires a prompt");
  return { prompt, json, outPath };
}

function buildOpenAIHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    originator: OPENAI_ORIGINATOR,
    "User-Agent": OPENAI_USER_AGENT,
    ...overrides,
  };
}

function buildHeaders(session: OpenAIImageGenerationSession): Record<string, string> {
  return {
    ...buildOpenAIHeaders({
      Authorization: `Bearer ${session.accessToken}`,
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    }),
    ...(session.accountId ? { "ChatGPT-Account-ID": session.accountId } : {}),
  };
}

function buildImageGenerationRequestBody(prompt: string): Record<string, unknown> {
  return {
    model: OPENAI_IMAGE_GENERATION_MODEL,
    instructions: IMAGE_GENERATION_INSTRUCTIONS,
    input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    tool_choice: "auto",
    parallel_tool_calls: false,
    tools: [{ type: "image_generation" }],
    stream: true,
    store: false,
  };
}

function extractImageGenerationItem(data: OpenAIImageGenerationResponse): OpenAIGeneratedImage {
  const output = Array.isArray(data.output) ? data.output as OpenAIImageGenerationResponseItem[] : [];
  const item = output.find((candidate) => candidate?.type === "image_generation_call");
  if (!item) throw new Error("OpenAI image generation returned no image_generation_call item");
  if (typeof item.result !== "string" || item.result.trim() === "") {
    throw new Error("OpenAI image generation returned empty image data");
  }
  return {
    id: typeof item.id === "string" ? item.id : null,
    status: typeof item.status === "string" ? item.status : null,
    revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : null,
    base64: item.result,
  };
}

function parseEventData(chunk: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  const pieces = chunk.split("\n\n");
  for (const piece of pieces) {
    const lines = piece.split("\n").map((line) => line.trim()).filter(Boolean);
    const dataLines = lines.filter((line) => line.startsWith("data: "));
    if (dataLines.length === 0) continue;
    const data = dataLines.map((line) => line.slice(6)).join("\n");
    if (data === "[DONE]") continue;
    try { events.push(JSON.parse(data) as Record<string, unknown>); } catch { /* ignore malformed stream fragments */ }
  }
  return events;
}

function extractImageFromEvent(event: Record<string, unknown>): OpenAIGeneratedImage | null {
  if (event.type === "response.output_item.done") {
    const item = event.item;
    if (item && typeof item === "object" && (item as { type?: unknown }).type === "image_generation_call") {
      return extractImageGenerationItem({ output: [item] });
    }
  }
  if (event.type === "response.completed" || event.type === "response.incomplete") {
    const response = event.response;
    if (response && typeof response === "object") {
      const output = (response as OpenAIImageGenerationResponse).output;
      if (Array.isArray(output) && output.some((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "image_generation_call")) {
        return extractImageGenerationItem(response as OpenAIImageGenerationResponse);
      }
    }
  }
  return null;
}

async function readImageGenerationStream(res: Response, stallTimeoutMs: number): Promise<OpenAIGeneratedImage> {
  if (!res.body) throw new Error("No response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let generated: OpenAIGeneratedImage | null = null;

  while (true) {
    let stallTimer: ReturnType<typeof setTimeout>;
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        stallTimer = setTimeout(() => reject(new Error(`No data for ${stallTimeoutMs / 1000}s`)), stallTimeoutMs);
      }),
    ]).finally(() => clearTimeout(stallTimer!));

    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const boundary = buffer.lastIndexOf("\n\n");
    if (boundary === -1) continue;
    const ready = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    for (const event of parseEventData(ready)) generated = extractImageFromEvent(event) ?? generated;
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    for (const event of parseEventData(buffer)) generated = extractImageFromEvent(event) ?? generated;
  }
  if (!generated) throw new Error("OpenAI image generation stream completed without an image_generation_call item");
  return generated;
}

async function generateImage(session: OpenAIImageGenerationSession, prompt: string): Promise<OpenAIGeneratedImage> {
  const res = await fetch(OPENAI_CODEX_RESPONSES_URL, {
    method: "POST",
    headers: buildHeaders(session),
    body: JSON.stringify(buildImageGenerationRequestBody(prompt)),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI image generation failed (${res.status}): ${text.slice(0, 500)}`);
  }
  return readImageGenerationStream(res, IMAGE_GENERATION_STALL_TIMEOUT_MS);
}

function repoRoot(): string {
  return resolve(import.meta.dir, "../../..");
}

function worktreeName(): string | null {
  try {
    const gitDir = execSync("git rev-parse --git-dir", { cwd: repoRoot(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const commonDir = execSync("git rev-parse --git-common-dir", { cwd: repoRoot(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (resolve(repoRoot(), gitDir) !== resolve(repoRoot(), commonDir)) return basename(gitDir);
  } catch { /* not a git checkout */ }
  return null;
}

function dataDir(): string {
  const configRoot = process.env.EXOCORTEX_CONFIG_DIR?.trim()
    ? resolve(process.env.EXOCORTEX_CONFIG_DIR)
    : join(repoRoot(), "config");
  const wt = worktreeName();
  return wt ? join(configRoot, "data", "instances", wt) : join(configRoot, "data");
}

function sniffImageMediaType(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 && bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return "image/jpeg";
  if (bytes.length >= 6) {
    const head = Buffer.from(bytes.subarray(0, 6)).toString("ascii");
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12) {
    const riff = Buffer.from(bytes.subarray(0, 4)).toString("ascii");
    const webp = Buffer.from(bytes.subarray(8, 12)).toString("ascii");
    if (riff === "RIFF" && webp === "WEBP") return "image/webp";
  }
  return "image/png";
}

function extensionForMediaType(mediaType: string): string {
  switch (mediaType) {
    case "image/jpeg": return "jpg";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    case "image/png":
    default: return "png";
  }
}

async function saveGeneratedImage(bytes: Uint8Array, mediaType: string, outPath: string | null): Promise<string> {
  const filePath = outPath
    ? resolve(outPath)
    : join(dataDir(), "generated-images", `${Date.now()}-${randomUUID().slice(0, 8)}.${extensionForMediaType(mediaType)}`);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);
  return filePath;
}

async function main(): Promise<void> {
  const { encodedAuth, rest } = parseGlobalArgs(process.argv.slice(2));
  const cmd = rest.shift();
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log(usage());
    return;
  }
  if (cmd !== "generate") die(`unknown command '${cmd}'. Run image -h for usage.`);

  const { prompt, json, outPath } = parseGenerateArgs(rest);
  const auth = decodeOpenAIAuth(encodedAuth);
  const generated = await generateImage(auth, prompt);
  const bytes = Buffer.from(generated.base64, "base64");
  if (bytes.length === 0) throw new Error("OpenAI image generation returned empty image data");
  const mediaType = sniffImageMediaType(bytes);
  const savedPath = await saveGeneratedImage(bytes, mediaType, outPath);

  if (json) {
    console.log(JSON.stringify({ path: savedPath, mediaType, revisedPrompt: generated.revisedPrompt }, null, 2));
  } else {
    console.log(savedPath);
  }
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
