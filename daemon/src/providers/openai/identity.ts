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

export interface CodexCompactionMetadata {
  reason?: "context_limit" | "model_downshift";
  phase?: "pre_turn" | "mid_turn";
}

export function buildCodexTurnMetadata(
  promptCacheKey: string,
  codexWindowId?: string,
  compactionMetadata?: CodexCompactionMetadata,
  codexTurnId?: string,
  codexTurnStartedAtMs?: number,
): Record<string, unknown> {
  const installationId = getCodexInstallationId();
  const windowId = codexWindowId ?? buildCodexWindowId(promptCacheKey);
  return {
    installation_id: installationId,
    session_id: promptCacheKey,
    thread_id: promptCacheKey,
    ...(codexTurnId ? { turn_id: codexTurnId } : {}),
    window_id: windowId,
    ...(codexTurnStartedAtMs != null ? { turn_started_at_unix_ms: codexTurnStartedAtMs } : {}),
    request_kind: compactionMetadata ? "compaction" : "turn",
    ...(compactionMetadata ? {
      compaction: {
        trigger: "auto",
        reason: compactionMetadata.reason ?? "context_limit",
        implementation: "responses_compaction_v2",
        phase: compactionMetadata.phase ?? "pre_turn",
        strategy: "memento",
      },
    } : {}),
  };
}

export function buildCodexClientMetadata(
  promptCacheKey?: string,
  codexWindowId?: string,
  compactionMetadata?: CodexCompactionMetadata,
  codexTurnId?: string,
  codexTurnStartedAtMs?: number,
): Record<string, string> {
  const metadata: Record<string, string> = {
    "x-codex-installation-id": getCodexInstallationId(),
  };
  if (promptCacheKey) {
    const windowId = codexWindowId ?? buildCodexWindowId(promptCacheKey);
    metadata.session_id = promptCacheKey;
    metadata.thread_id = promptCacheKey;
    if (codexTurnId) metadata.turn_id = codexTurnId;
    metadata["x-codex-window-id"] = windowId;
    if (codexTurnId || compactionMetadata) {
      metadata["x-codex-turn-metadata"] = JSON.stringify(
        buildCodexTurnMetadata(
          promptCacheKey,
          windowId,
          compactionMetadata,
          codexTurnId,
          codexTurnStartedAtMs,
        ),
      );
    }
  }
  return metadata;
}

export function buildCodexWindowId(promptCacheKey: string): string {
  return `${promptCacheKey}:0`;
}
