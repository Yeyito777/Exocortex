import type { StreamCallbacks, StreamResult } from "../types";
import { readOpenAICompatibleEventsForTest, readOpenAICompatibleStream } from "../openai-compatible/stream";

export function readDeepSeekEventsForTest(
  events: Record<string, unknown>[],
  callbacks: Partial<StreamCallbacks> = {},
): StreamResult {
  return readOpenAICompatibleEventsForTest(events, callbacks, "DeepSeek");
}

export function readDeepSeekStream(res: Response, cb: StreamCallbacks, stallTimeoutMs: number): Promise<StreamResult> {
  return readOpenAICompatibleStream(res, cb, stallTimeoutMs, "DeepSeek");
}
