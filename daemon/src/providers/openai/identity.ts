import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { storageDir } from "@exocortex/shared/paths";

const INSTALLATION_ID_FILE = join(storageDir(), "openai-codex-installation-id");

let cachedInstallationId: string | null = null;

export function getCodexInstallationId(): string {
  if (cachedInstallationId) return cachedInstallationId;

  try {
    if (existsSync(INSTALLATION_ID_FILE)) {
      const existing = readFileSync(INSTALLATION_ID_FILE, "utf8").trim();
      if (existing) {
        cachedInstallationId = existing;
        return existing;
      }
    }

    const id = randomUUID();
    mkdirSync(storageDir(), { recursive: true });
    writeFileSync(INSTALLATION_ID_FILE, `${id}\n`, { mode: 0o600 });
    cachedInstallationId = id;
    return id;
  } catch {
    cachedInstallationId = randomUUID();
    return cachedInstallationId;
  }
}

export function buildCodexClientMetadata(promptCacheKey?: string): Record<string, string> {
  const metadata: Record<string, string> = {
    "x-codex-installation-id": getCodexInstallationId(),
  };
  if (promptCacheKey) {
    metadata["x-codex-window-id"] = buildCodexWindowId(promptCacheKey);
  }
  return metadata;
}

export function buildCodexWindowId(promptCacheKey: string): string {
  return `${promptCacheKey}:0`;
}
