import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chronoDir, configDir } from "@exocortex/shared/paths";
import { chronoMigrationInternalsForTest, migrateLegacyCronJobs } from "./chrono-migration";
import { chronoInternalsForTest, listChronoSchedules } from "./chrono-service";

afterEach(() => {
  chronoInternalsForTest.reset();
  rmSync(join(configDir(), "cron"), { recursive: true, force: true });
  rmSync(chronoDir(), { recursive: true, force: true });
});

describe("legacy cron migration", () => {
  test("reads legacy headers and infers literal conversation owners", () => {
    const content = `#!/bin/bash\n# schedule: 0 8 * * 1,3,5\n# description: AI digest\n# timeout: 3600\nexo send hi -c 1772101534021-6d8ske\n`;
    expect(chronoMigrationInternalsForTest.parseHeaders(content)).toEqual({
      schedule: "0 8 * * 1,3,5",
      description: "AI digest",
      timeoutSeconds: 3600,
    });
    expect(chronoMigrationInternalsForTest.inferredConversationId(content)).toBe("1772101534021-6d8ske");
  });

  test("infers a shell CONV_ID assignment", () => {
    expect(chronoMigrationInternalsForTest.inferredConversationId('CONV_ID="1774169062894-038twc"\nexo send hi -c "$CONV_ID"'))
      .toBe("1774169062894-038twc");
  });

  test("atomically imports executable scripts as durable command soft-wakes", () => {
    const legacyDir = join(configDir(), "cron");
    mkdirSync(legacyDir, { recursive: true });
    const source = join(legacyDir, "backup.sh");
    writeFileSync(source, "#!/bin/bash\n# schedule: */30 * * * *\n# description: Backup data\n# timeout: 180\nprintf ok\n");
    chmodSync(source, 0o700);

    expect(migrateLegacyCronJobs(Date.parse("2026-07-11T12:01:00Z"))).toBe(1);
    expect(existsSync(source)).toBe(false);
    const schedules = listChronoSchedules();
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({
      title: "Backup data",
      recurrence: { kind: "cron", expression: "*/30 * * * *" },
      target: { kind: "command", timeoutMs: 180_000 },
      source: "legacy-cron",
    });
    if (schedules[0].target.kind !== "command") throw new Error("expected command target");
    const migratedPathLiteral = schedules[0].target.command.match(/&& bash (.+)$/)?.[1];
    expect(migratedPathLiteral).toBeDefined();
    expect(existsSync(JSON.parse(migratedPathLiteral!))).toBe(true);
  });
});
