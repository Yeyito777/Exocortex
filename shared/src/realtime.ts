export const REALTIME_VOICES = [
  "juniper",
  "maple",
  "spruce",
  "ember",
  "vale",
  "breeze",
  "arbor",
  "sol",
  "cove",
] as const;

export type RealtimeVoice = typeof REALTIME_VOICES[number];

export const DEFAULT_REALTIME_VOICE: RealtimeVoice = "cove";

export function isRealtimeVoice(value: unknown): value is RealtimeVoice {
  return typeof value === "string" && (REALTIME_VOICES as readonly string[]).includes(value);
}
