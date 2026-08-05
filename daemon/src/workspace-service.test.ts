import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { conversationWorkspaceDir, conversationWorkspacesDir, trashedConversationWorkspaceDir, trashedConversationWorkspacesDir } from "@exocortex/shared/paths";
import { createConversationWorkspace, ensureConversationWorkspace, reconcileConversationWorkspaces, restoreConversationWorkspace, trashConversationWorkspace } from "./workspace-service";

const ids: string[] = [];

function id(label: string): string {
  const value = `workspace-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  ids.push(value);
  return value;
}

afterEach(() => {
  for (const conversationId of ids.splice(0)) {
    rmSync(conversationWorkspaceDir(conversationId), { recursive: true, force: true });
    rmSync(trashedConversationWorkspaceDir(conversationId), { recursive: true, force: true });
    for (const entry of readdirSync(trashedConversationWorkspacesDir(), { withFileTypes: true })) {
      if (entry.name.startsWith(`${conversationId}.replaced-`) || entry.name.startsWith(`${conversationId}.orphaned-`)) {
        rmSync(join(trashedConversationWorkspacesDir(), entry.name), { recursive: true, force: true });
      }
    }
  }
});

describe("conversation workspace service", () => {
  test("creates a stable lazy workspace", () => {
    const conversationId = id("create");
    const first = ensureConversationWorkspace(conversationId);
    const second = ensureConversationWorkspace(conversationId);
    expect(first).toBe(conversationWorkspaceDir(conversationId));
    expect(second).toBe(first);
    expect(existsSync(first)).toBe(true);
  });

  test("trashes and restores workspace contents", () => {
    const conversationId = id("restore");
    const live = ensureConversationWorkspace(conversationId);
    writeFileSync(join(live, "state.txt"), "preserved");

    expect(trashConversationWorkspace(conversationId)).toBe(true);
    expect(existsSync(live)).toBe(false);
    expect(readFileSync(join(trashedConversationWorkspaceDir(conversationId), "state.txt"), "utf8")).toBe("preserved");

    expect(restoreConversationWorkspace(conversationId)).toBe(live);
    expect(readFileSync(join(live, "state.txt"), "utf8")).toBe("preserved");
  });

  test("lazy ensure recovers a workspace left in trash after a partial restore", () => {
    const conversationId = id("recover");
    const live = ensureConversationWorkspace(conversationId);
    writeFileSync(join(live, "state.txt"), "recovered");
    trashConversationWorkspace(conversationId);

    expect(ensureConversationWorkspace(conversationId)).toBe(live);
    expect(readFileSync(join(live, "state.txt"), "utf8")).toBe("recovered");
  });

  test("new conversation creation never revives a trashed workspace", () => {
    const conversationId = id("no-reuse");
    const first = createConversationWorkspace(conversationId);
    writeFileSync(join(first, "old.txt"), "old");
    trashConversationWorkspace(conversationId);
    const replacement = createConversationWorkspace(conversationId);
    expect(existsSync(join(replacement, "old.txt"))).toBe(false);
    expect(readFileSync(join(trashedConversationWorkspaceDir(conversationId), "old.txt"), "utf8")).toBe("old");

    writeFileSync(join(replacement, "new.txt"), "new");
    trashConversationWorkspace(conversationId);
    expect(readFileSync(join(trashedConversationWorkspaceDir(conversationId), "new.txt"), "utf8")).toBe("new");
    expect(readdirSync(trashedConversationWorkspacesDir()).some(entry => entry.startsWith(`${conversationId}.replaced-`))).toBe(true);
  });

  test("new conversation creation preserves an orphaned live workspace and starts clean", () => {
    const conversationId = id("no-live-reuse");
    const orphan = createConversationWorkspace(conversationId);
    writeFileSync(join(orphan, "orphan.txt"), "orphan");
    const replacement = createConversationWorkspace(conversationId);
    expect(existsSync(join(replacement, "orphan.txt"))).toBe(false);
    expect(readFileSync(join(trashedConversationWorkspaceDir(conversationId), "orphan.txt"), "utf8")).toBe("orphan");
  });

  test("refuses a restore when canonical trash collides with nonempty live data", () => {
    const conversationId = id("restore-collision");
    const old = createConversationWorkspace(conversationId);
    writeFileSync(join(old, "old.txt"), "old");
    trashConversationWorkspace(conversationId);
    const foreign = createConversationWorkspace(conversationId);
    writeFileSync(join(foreign, "foreign.txt"), "foreign");

    expect(() => restoreConversationWorkspace(conversationId)).toThrow("Refusing to overwrite");
    expect(() => ensureConversationWorkspace(conversationId)).toThrow("Refusing to choose");
    expect(readFileSync(join(trashedConversationWorkspaceDir(conversationId), "old.txt"), "utf8")).toBe("old");
    expect(readFileSync(join(foreign, "foreign.txt"), "utf8")).toBe("foreign");
  });

  test("startup reconciliation moves unindexed live workspaces to trash", () => {
    const orphanId = id("reconcile-orphan");
    const liveId = id("reconcile-live");
    writeFileSync(join(createConversationWorkspace(orphanId), "orphan.txt"), "orphan");
    createConversationWorkspace(liveId);

    const otherLiveIds = readdirSync(conversationWorkspacesDir())
      .filter(entry => entry !== orphanId);
    const report = reconcileConversationWorkspaces(otherLiveIds);
    expect(report).toEqual({ movedToTrash: [orphanId], errors: [] });
    expect(existsSync(conversationWorkspaceDir(orphanId))).toBe(false);
    expect(existsSync(conversationWorkspaceDir(liveId))).toBe(true);
  });

  test("reconciliation does not replace canonical trash with a crashed replacement create", () => {
    const conversationId = id("reconcile-reuse-crash");
    const original = createConversationWorkspace(conversationId);
    writeFileSync(join(original, "original.txt"), "original");
    trashConversationWorkspace(conversationId);
    const crashedReplacement = createConversationWorkspace(conversationId);
    writeFileSync(join(crashedReplacement, "replacement.txt"), "replacement");

    const otherLiveIds = readdirSync(conversationWorkspacesDir()).filter(entry => entry !== conversationId);
    reconcileConversationWorkspaces(otherLiveIds);

    expect(readFileSync(join(trashedConversationWorkspaceDir(conversationId), "original.txt"), "utf8")).toBe("original");
    const orphan = readdirSync(trashedConversationWorkspacesDir())
      .find(entry => entry.startsWith(`${conversationId}.orphaned-`));
    expect(orphan).toBeDefined();
    expect(readFileSync(join(trashedConversationWorkspacesDir(), orphan!, "replacement.txt"), "utf8")).toBe("replacement");
  });
});
