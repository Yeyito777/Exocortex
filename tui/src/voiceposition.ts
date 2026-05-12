import { graphemeAt, nextGraphemeEnd } from "./graphemes";
import type { VoicePromptState } from "./voice";

function lineEndFrom(buffer: string, pos: number): number {
  const newline = buffer.indexOf("\n", pos);
  return newline === -1 ? buffer.length : newline;
}

export function resolveVoiceInsertionPos(buffer: string, cursorPos: number): number {
  if (cursorPos < 0) return 0;
  if (cursorPos >= buffer.length) return buffer.length;

  const char = graphemeAt(buffer, cursorPos);
  const charEnd = nextGraphemeEnd(buffer, cursorPos);
  if (char && !/\s/.test(char) && charEnd === lineEndFrom(buffer, cursorPos)) {
    return charEnd;
  }
  return cursorPos;
}

export function hasEarlierVoiceJobAtInsertion(
  jobs: VoicePromptState[],
  insertionPos: number,
  jobId?: number,
): boolean {
  return jobs.some(job =>
    job.insertionPos === insertionPos
    && (jobId === undefined || (job.id ?? 0) < jobId)
  );
}

export function deriveVoicePrefixText(
  buffer: string,
  insertionPos: number,
  jobs: VoicePromptState[] = [],
  jobId?: number,
): string {
  if (hasEarlierVoiceJobAtInsertion(jobs, insertionPos, jobId)) return " ";
  if (insertionPos <= 0) return "";
  const prevChar = buffer[insertionPos - 1];
  return /\s/.test(prevChar) ? "" : " ";
}

export function deriveVoiceSuffixText(buffer: string, insertionPos: number): string {
  if (insertionPos >= buffer.length) return "";
  const nextChar = graphemeAt(buffer, insertionPos);
  if (!nextChar || /\s/.test(nextChar)) return "";
  // Do not split natural punctuation from the transcribed phrase, but do keep
  // word-like continuations and slash macros/commands at a real word boundary.
  return /^[.,!?;:)\]\}'”]$/.test(nextChar) ? "" : " ";
}
