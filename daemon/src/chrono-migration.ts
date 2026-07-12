/** One-time migration from config/cron shell headers into Chrono schedules. */

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, join } from "node:path";
import { chronoDir, configDir } from "@exocortex/shared/paths";
import {
  installMigratedSchedule,
  listChronoSchedules,
  nextMigratedCronOccurrence,
  type ChronoSchedule,
} from "./chrono-service";
import { log } from "./log";

interface Headers {
  schedule: string;
  description: string;
  timeoutSeconds: number;
}

function parseHeaders(content: string): Headers | null {
  let schedule = "";
  let description = "";
  let timeoutSeconds = 300;
  for (const line of content.split("\n").slice(0, 20)) {
    const scheduleMatch = line.match(/^#\s*schedule:\s*(.+)$/i);
    if (scheduleMatch) schedule = scheduleMatch[1].trim();
    const descriptionMatch = line.match(/^#\s*description:\s*(.+)$/i);
    if (descriptionMatch) description = descriptionMatch[1].trim();
    const timeoutMatch = line.match(/^#\s*timeout:\s*(\d+)$/i);
    if (timeoutMatch) timeoutSeconds = Number(timeoutMatch[1]);
  }
  return schedule ? { schedule, description, timeoutSeconds } : null;
}

function inferredConversationId(content: string): string | undefined {
  const assigned = content.match(/^\s*(?:readonly\s+)?CONV_ID=["']([0-9]+-[a-z0-9]+)["']/m)?.[1];
  if (assigned) return assigned;
  return content.match(/(?:^|\s)(?:-c|--conversation(?:-id)?)\s+["']?([0-9]+-[a-z0-9]+)["']?/m)?.[1];
}

function safeExecutable(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (process.platform === "win32" || !!(stat.mode & 0o100));
  } catch {
    return false;
  }
}

/**
 * Copy first, persist the deterministic schedule, then unlink the old source.
 * Re-running after any crash window is idempotent.
 */
export function migrateLegacyCronJobs(now = Date.now()): number {
  const legacyDir = join(configDir(), "cron");
  if (!existsSync(legacyDir)) return 0;
  const scriptsDir = join(chronoDir(), "scripts");
  mkdirSync(scriptsDir, { recursive: true, mode: 0o700 });
  const existing = new Set(listChronoSchedules().map(schedule => schedule.id));
  let migrated = 0;

  for (const entry of readdirSync(legacyDir)) {
    if (!entry.endsWith(".sh")) continue;
    const sourcePath = join(legacyDir, entry);
    if (!safeExecutable(sourcePath)) continue;
    try {
      const content = readFileSync(sourcePath, "utf8");
      const headers = parseHeaders(content);
      if (!headers) continue;
      const digest = createHash("sha256").update(entry).update("\0").update(content).digest("hex").slice(0, 20);
      const id = `chrono:migrated:${digest}`;
      const destinationPath = join(scriptsDir, basename(entry).replace(/\.sh$/, `-${digest.slice(0, 8)}.sh`));
      if (!existsSync(destinationPath) || readFileSync(destinationPath, "utf8") !== content) {
        const tempPath = `${destinationPath}.${process.pid}.${Date.now()}.tmp`;
        try {
          copyFileSync(sourcePath, tempPath);
          chmodSync(tempPath, 0o700);
          renameSync(tempPath, destinationPath);
        } finally {
          rmSync(tempPath, { force: true });
        }
      }
      if (!existing.has(id)) {
        const ownerConversationId = inferredConversationId(content);
        const schedule: ChronoSchedule = {
          id,
          ...(ownerConversationId ? { ownerConversationId } : {}),
          title: headers.description || entry.replace(/\.sh$/, ""),
          createdAt: now,
          nextAt: nextMigratedCronOccurrence(headers.schedule, now),
          recurrence: { kind: "cron", expression: headers.schedule },
          target: {
            kind: "command",
            command: `cd ${JSON.stringify(process.env.HOME ?? ".")} && bash ${JSON.stringify(destinationPath)}`,
            timeoutMs: Math.max(1, headers.timeoutSeconds) * 1000,
            ...(ownerConversationId ? {
              hardWake: {
                conversationId: ownerConversationId,
                when: "failure",
                message: `The migrated automation '${headers.description || entry}' failed. Investigate and recover it.`,
                includeOutput: true,
              },
            } : {}),
          },
          source: "legacy-cron",
        };
        installMigratedSchedule(schedule);
        existing.add(id);
        migrated++;
      }
      unlinkSync(sourcePath);
    } catch (err) {
      log("error", `chrono migration: could not migrate ${entry}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return migrated;
}

export const chronoMigrationInternalsForTest = { parseHeaders, inferredConversationId };
