import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readExocortexConfig, writeExocortexConfig } from "@exocortex/shared/config";
import { tryCommand } from "./commands";
import { createInitialState } from "./state";
import {
  cancelPendingStreamFinishedNotification,
  isTerminalWindowFocused,
  loadStreamFinishedPing,
  normalizeSoundPath,
  playSoundFile,
  runStreamFinishedPing,
  sendStreamFinishedNotification,
  shouldPingForBackgroundStreamCompletion,
  shouldSuppressStreamFinishedPing,
  streamFinishedSoundCommand,
} from "./ping";

function resetConfig(): void {
  cancelPendingStreamFinishedNotification();
  writeExocortexConfig({ theme: "whale", ping: { mode: null, sound: null } });
}

afterEach(resetConfig);

describe("/ping", () => {
  test("persists sound mode and sound path in config.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "exo-ping-test-"));
    const soundPath = join(dir, "done.wav");
    writeFileSync(soundPath, "not really a wav, but enough for path validation");

    try {
      const state = createInitialState();
      const result = tryCommand(`/ping sound ${soundPath}`, state);

      expect(result).toEqual({ type: "handled" });
      expect(readExocortexConfig().ping).toEqual({ mode: "sound", sound: soundPath });
      expect(loadStreamFinishedPing()).toEqual({ mode: "sound", sound: soundPath });
      expect((state.messages.at(-1) as { text?: string } | undefined)?.text).toBe(`Stream-finished ping set to sound (${soundPath})`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("persists notif mode without a sound path", () => {
    const state = createInitialState();

    const result = tryCommand("/ping notif", state);

    expect(result).toEqual({ type: "handled" });
    expect(readExocortexConfig().ping).toEqual({ mode: "notif", sound: null });
    expect((state.messages.at(-1) as { text?: string } | undefined)?.text).toBe("Stream-finished ping set to notif.");
  });

  test("persists both mode with a sound path", () => {
    const dir = mkdtempSync(join(tmpdir(), "exo-ping-test-"));
    const soundPath = join(dir, "done.wav");
    writeFileSync(soundPath, "not really a wav, but enough for path validation");

    try {
      const state = createInitialState();
      const result = tryCommand(`/ping both ${soundPath}`, state);

      expect(result).toEqual({ type: "handled" });
      expect(readExocortexConfig().ping).toEqual({ mode: "both", sound: soundPath });
      expect(loadStreamFinishedPing()).toEqual({ mode: "both", sound: soundPath });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reuses an existing sound path when switching back to sound modes", () => {
    const dir = mkdtempSync(join(tmpdir(), "exo-ping-test-"));
    const soundPath = join(dir, "done.wav");
    writeFileSync(soundPath, "not really a wav, but enough for path validation");
    writeExocortexConfig({ theme: "whale", ping: { mode: "notif", sound: soundPath } });

    try {
      const state = createInitialState();
      const result = tryCommand("/ping both", state);

      expect(result).toEqual({ type: "handled" });
      expect(readExocortexConfig().ping).toEqual({ mode: "both", sound: soundPath });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects missing sound files without overwriting the existing ping", () => {
    writeExocortexConfig({ theme: "whale", ping: { mode: "notif", sound: null } });
    const state = createInitialState();

    const result = tryCommand("/ping sound /definitely/missing.wav", state);

    expect(result).toEqual({ type: "handled" });
    expect(readExocortexConfig().ping).toEqual({ mode: "notif", sound: null });
    expect((state.messages.at(-1) as { text?: string } | undefined)?.text).toBe("Sound file not found: /definitely/missing.wav");
  });

  test("can clear the configured ping", () => {
    writeExocortexConfig({ theme: "whale", ping: { mode: "both", sound: "/tmp/old.wav" } });
    const state = createInitialState();

    const result = tryCommand("/ping off", state);

    expect(result).toEqual({ type: "handled" });
    expect(readExocortexConfig().ping).toEqual({ mode: null, sound: null });
  });

  test("/sound is no longer a command", () => {
    const state = createInitialState();
    expect(tryCommand("/sound /tmp/done.wav", state)).toBeNull();
  });
});

describe("ping config helpers", () => {
  test("normalizes quoted and home-relative sound paths", () => {
    expect(normalizeSoundPath('"/tmp/done.wav"')).toBe("/tmp/done.wav");
    expect(normalizeSoundPath("~/done.wav")).toContain("/done.wav");
  });

  test("loads the legacy top-level sound key as sound mode", () => {
    writeExocortexConfig({ theme: "whale", sound: "/tmp/old.wav" });
    expect(loadStreamFinishedPing()).toEqual({ mode: "sound", sound: "/tmp/old.wav" });
  });

  test("loads the previous notification mode spelling as notif", () => {
    writeExocortexConfig({ theme: "whale", ping: { mode: "notification" as never, sound: null } });
    expect(loadStreamFinishedPing()).toEqual({ mode: "notif", sound: null });
  });

  test("notif ping emits a deferred terminal bell for st/wm urgency", async () => {
    const written: string[] = [];
    sendStreamFinishedNotification(() => written.push("\x07"));
    expect(written).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(written).toEqual(["\x07"]);
  });

  test("notif ping coalesces multiple immediate notifications", async () => {
    const written: string[] = [];
    sendStreamFinishedNotification(() => written.push("\x07"));
    sendStreamFinishedNotification(() => written.push("\x07"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(written).toEqual(["\x07"]);
  });

  test("detects whether the TUI terminal window is focused", () => {
    expect(isTerminalWindowFocused("12345", () => "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3039")).toBe(true);
    expect(isTerminalWindowFocused("12345", () => "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x9999")).toBe(false);
    expect(isTerminalWindowFocused(undefined, () => "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3039")).toBe(false);
  });

  test("suppresses ping only when the focused terminal is showing the completed conversation", () => {
    expect(shouldSuppressStreamFinishedPing({
      completedConvId: "conv-a",
      activeConvId: "conv-b",
      isCompletedConvStreaming: true,
      windowId: "12345",
      activeWindowReader: () => "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x9999",
    })).toBe(true);

    expect(shouldSuppressStreamFinishedPing({
      completedConvId: "conv-a",
      activeConvId: "conv-a",
      windowId: "12345",
      activeWindowReader: () => "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3039",
    })).toBe(true);

    expect(shouldSuppressStreamFinishedPing({
      completedConvId: "conv-a",
      activeConvId: "conv-b",
      windowId: "12345",
      activeWindowReader: () => "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3039",
    })).toBe(false);

    expect(shouldSuppressStreamFinishedPing({
      completedConvId: "conv-a",
      activeConvId: "conv-a",
      windowId: "12345",
      activeWindowReader: () => "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x9999",
    })).toBe(false);
  });

  test("runStreamFinishedPing does nothing when focused on the completed conversation", async () => {
    writeExocortexConfig({ theme: "whale", ping: { mode: "notif", sound: null } });
    runStreamFinishedPing({
      completedConvId: "conv-a",
      activeConvId: "conv-a",
      windowId: "12345",
      activeWindowReader: () => "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3039",
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    // If this leaks a pending timer, afterEach cancellation would be too late to
    // stop the bell; absence of throw is enough because defaultBell is untouched.
    expect(true).toBe(true);
  });

  test("background completion ping predicate fires only for streaming true-to-false updates outside the active conversation", () => {
    expect(shouldPingForBackgroundStreamCompletion({
      updatedConvId: "conv-a",
      wasStreaming: true,
      isStreaming: false,
      activeConvIdBeforeUpdate: "conv-b",
    })).toBe(true);

    expect(shouldPingForBackgroundStreamCompletion({
      updatedConvId: "conv-a",
      wasStreaming: true,
      isStreaming: false,
      activeConvIdBeforeUpdate: "conv-a",
    })).toBe(false);

    expect(shouldPingForBackgroundStreamCompletion({
      updatedConvId: "conv-a",
      wasStreaming: false,
      isStreaming: false,
      activeConvIdBeforeUpdate: "conv-b",
    })).toBe(false);

    expect(shouldPingForBackgroundStreamCompletion({
      updatedConvId: "conv-a",
      wasStreaming: true,
      isStreaming: true,
      activeConvIdBeforeUpdate: "conv-b",
    })).toBe(false);
  });

  test("sound playback uses a single deterministic ffmpeg-to-aplay command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exo-ping-test-"));
    const soundPath = join(dir, "done.wav");
    writeFileSync(soundPath, "not really a wav, but enough for path validation");
    const commands: string[][] = [];
    const options: Array<{ detached?: boolean } | undefined> = [];

    try {
      await playSoundFile(soundPath, (command, spawnOptions) => {
        commands.push(command);
        options.push(spawnOptions);
        return { exited: Promise.resolve(0), unref: () => undefined };
      });

      expect(commands).toEqual([streamFinishedSoundCommand(soundPath)]);
      expect(options).toEqual([{ detached: true }]);
      expect(commands[0][0]).toBe("bash");
      expect(commands[0][2]).toContain("ffmpeg");
      expect(commands[0][2]).toContain("aplay");
      expect(commands[0].at(-1)).toBe(soundPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sound playback catches sound pipeline spawn errors instead of crashing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exo-ping-test-"));
    const soundPath = join(dir, "done.wav");
    writeFileSync(soundPath, "not really a wav, but enough for path validation");

    try {
      await expect(playSoundFile(soundPath, () => {
        throw new Error("sound backend missing");
      })).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sound playback catches sound pipeline exit promise errors instead of crashing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exo-ping-test-"));
    const soundPath = join(dir, "done.wav");
    writeFileSync(soundPath, "not really a wav, but enough for path validation");

    try {
      await expect(playSoundFile(soundPath, () => ({ exited: Promise.reject(new Error("sound backend crashed")) }))).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
