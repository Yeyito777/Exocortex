import { zstdCompressSync } from "node:zlib";

export interface EncodedOpenAIRequestBody {
  body: BodyInit;
  headers: Record<string, string>;
}

const COMPRESS_REQUESTS = process.env.OPENAI_DISABLE_ZSTD_REQUESTS !== "1";

export function encodeOpenAIRequestBody(body: Record<string, unknown>): EncodedOpenAIRequestBody {
  const json = JSON.stringify(body);
  if (!COMPRESS_REQUESTS) {
    return { body: json, headers: {} };
  }

  return {
    body: zstdCompressSync(Buffer.from(json)),
    headers: { "Content-Encoding": "zstd" },
  };
}
