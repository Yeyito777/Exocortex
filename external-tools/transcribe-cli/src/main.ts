import { readFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { basename, extname } from "node:path";

const OPENAI_ORIGINATOR = "codex_cli_rs";
const OPENAI_CODEX_CLIENT_VERSION = process.env.OPENAI_CODEX_CLIENT_VERSION?.trim() || "0.99.0";
const CHATGPT_BASE_URL = (process.env.OPENAI_CHATGPT_BASE_URL?.trim() || "https://chatgpt.com").replace(/\/+$/, "");
const OPENAI_TRANSCRIBE_URL = `${CHATGPT_BASE_URL}/backend-api/transcribe`;
const OPENAI_USER_AGENT = `${OPENAI_ORIGINATOR}/${OPENAI_CODEX_CLIENT_VERSION} (${platform()} ${release()}; ${arch()}) exocortex-transcribe-cli/openai`;
const OPENAI_AUTH_ARG = "--exocortex-auth-openai";
const UNKNOWN_AUDIO_MIME_TYPE = "application/octet-stream";

const AUDIO_MIME_BY_EXTENSION: Record<string, string> = {
  ".aac": "audio/aac",
  ".aif": "audio/aiff",
  ".aiff": "audio/aiff",
  ".amr": "audio/amr",
  ".caf": "audio/x-caf",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".mka": "audio/x-matroska",
  ".mp3": "audio/mpeg",
  ".mp4": "audio/mp4",
  ".mpeg": "audio/mpeg",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".wave": "audio/wav",
  ".weba": "audio/webm",
  ".webm": "audio/webm",
};

interface OpenAIAuthPayload {
  provider?: unknown;
  accessToken?: unknown;
  accountId?: unknown;
}

interface OpenAITranscriptionSession {
  accessToken: string;
  accountId: string | null;
}

interface TranscriptionResponse {
  text?: unknown;
}

function usage(): string {
  return `usage: transcribe [options] <audio-file>\n\noptions:\n  --mime-type <type>   Override inferred MIME type\n  --json               Print JSON instead of plain transcript text\n  -h, --help           Show this help\n\nThis tool expects daemon-provided OpenAI auth (${OPENAI_AUTH_ARG}).`;
}

function die(message: string, code = 1): never {
  console.error(`transcribe: ${message}`);
  process.exit(code);
}

function decodeOpenAIAuth(encoded: string | undefined): OpenAITranscriptionSession {
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

function parseArgs(argv: string[]): { encodedAuth: string | undefined; filePath: string; mimeType: string | null; json: boolean } {
  let encodedAuth: string | undefined;
  let mimeType: string | null = null;
  let json = false;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === OPENAI_AUTH_ARG) {
      encodedAuth = argv[++i];
      if (!encodedAuth) die(`${OPENAI_AUTH_ARG} requires a value`);
    } else if (arg.startsWith(`${OPENAI_AUTH_ARG}=`)) {
      encodedAuth = arg.slice(OPENAI_AUTH_ARG.length + 1);
    } else if (arg === "--mime-type" || arg === "--mime") {
      mimeType = argv[++i] ?? null;
      if (!mimeType) die(`${arg} requires a value`);
    } else if (arg.startsWith("--mime-type=")) {
      mimeType = arg.slice("--mime-type=".length);
      if (!mimeType) die("--mime-type requires a value");
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "-h" || arg === "--help" || arg === "help") {
      console.log(usage());
      process.exit(0);
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length !== 1) die("expected exactly one audio file path");
  return { encodedAuth, filePath: positionals[0]!, mimeType, json };
}

function inferAudioMimeType(filePath: string): string | null {
  return AUDIO_MIME_BY_EXTENSION[extname(filePath).toLowerCase()] ?? null;
}

function buildOpenAIHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    originator: OPENAI_ORIGINATOR,
    "User-Agent": OPENAI_USER_AGENT,
    ...overrides,
  };
}

async function transcribeAudioWithSession(
  session: OpenAITranscriptionSession,
  audioBytes: Uint8Array,
  mimeType: string,
  filename: string,
): Promise<string> {
  if (audioBytes.byteLength === 0) throw new Error("Audio file is empty");

  const form = new FormData();
  form.append("file", new Blob([Buffer.from(audioBytes)], { type: mimeType }), filename);

  const headers = buildOpenAIHeaders({ Authorization: `Bearer ${session.accessToken}` });
  if (session.accountId) headers["ChatGPT-Account-ID"] = session.accountId;

  const res = await fetch(OPENAI_TRANSCRIBE_URL, {
    method: "POST",
    headers,
    body: form,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI transcription failed (${res.status}): ${text.slice(0, 500)}`);
  }

  const data = await res.json() as TranscriptionResponse;
  const text = typeof data.text === "string" ? data.text.trim() : "";
  if (!text) throw new Error("OpenAI transcription returned an empty result");
  return text;
}

async function main(): Promise<void> {
  const { encodedAuth, filePath, mimeType, json } = parseArgs(process.argv.slice(2));
  const auth = decodeOpenAIAuth(encodedAuth);
  const bytes = await readFile(filePath);
  const effectiveMimeType = (mimeType?.trim() || inferAudioMimeType(filePath) || UNKNOWN_AUDIO_MIME_TYPE);
  const text = await transcribeAudioWithSession(auth, bytes, effectiveMimeType, basename(filePath));
  if (json) console.log(JSON.stringify({ text, mimeType: effectiveMimeType }, null, 2));
  else console.log(text);
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
