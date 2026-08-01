import { readExocortexConfig, updateExocortexConfig } from "@exocortex/shared/config";

export const DEFAULT_MIC_GAIN_DB = 0;

export function normalizeMicGainDb(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MIC_GAIN_DB;
  return Object.is(value, -0) ? 0 : value;
}

export function parseMicGainDb(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (value.trim().toLowerCase() === "reset") return DEFAULT_MIC_GAIN_DB;
  const match = value.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?:\s*db)?$/i);
  if (!match) return null;
  const gain = Number.parseFloat(match[1] ?? "");
  return Number.isFinite(gain) ? normalizeMicGainDb(gain) : null;
}

export function formatMicGainDb(value: number): string {
  const gain = normalizeMicGainDb(value);
  const text = Number.isInteger(gain) ? String(gain) : String(gain).replace(/0+$/u, "").replace(/\.$/u, "");
  return `${text}dB`;
}

export function loadMicGainDb(): number {
  const configured = readExocortexConfig().audio?.micGainDb;
  return typeof configured === "number" && Number.isFinite(configured)
    ? normalizeMicGainDb(configured)
    : DEFAULT_MIC_GAIN_DB;
}

export function saveMicGainDb(value: number): number {
  const gain = normalizeMicGainDb(value);
  updateExocortexConfig(config => {
    config.audio = { ...config.audio, micGainDb: gain };
  });
  return gain;
}
