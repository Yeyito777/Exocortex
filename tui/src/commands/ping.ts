import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import {
  clearStreamFinishedPing,
  isUsableSoundFile,
  loadStreamFinishedPing,
  normalizeSoundPath,
  saveStreamFinishedPing,
  type StreamFinishedPingMode,
} from "../ping";
import type { SlashCommand } from "./types";

const USAGE = "Usage: /ping <sound|notif|both> [sound-file]\n\nExamples:\n  /ping notif\n  /ping sound /path/to/done.wav\n  /ping both /path/to/done.wav";

function pingArgs(text: string): string[] {
  return text.replace(/^\/ping(?:\s+|$)/, "").trim().split(/\s+/).filter(Boolean);
}

function formatCurrentPing(): string {
  const current = loadStreamFinishedPing();
  if (!current.mode) return `No stream-finished ping configured.\n\n${USAGE}`;
  if (current.mode === "notif") return "Current stream-finished ping: notif";
  return `Current stream-finished ping: ${current.mode}${current.sound ? ` (${current.sound})` : " (no sound file configured)"}`;
}

function configureSoundMode(mode: Extract<StreamFinishedPingMode, "sound" | "both">, rawPath: string | undefined, state: Parameters<SlashCommand["handler"]>[1]) {
  const existing = loadStreamFinishedPing().sound;
  if (!rawPath && !existing) {
    pushSystemMessage(state, USAGE);
    clearPrompt(state);
    return { type: "handled" } as const;
  }

  const path = rawPath ? normalizeSoundPath(rawPath) : existing!;
  if (!isUsableSoundFile(path)) {
    pushSystemMessage(state, `Sound file not found: ${path}`);
    clearPrompt(state);
    return { type: "handled" } as const;
  }

  saveStreamFinishedPing(mode, path);
  pushSystemMessage(state, `Stream-finished ping set to ${mode} (${path})`);
  clearPrompt(state);
  return { type: "handled" } as const;
}

export const PING_COMMAND: SlashCommand = {
  name: "/ping",
  description: "Set the ping when an AI response finishes",
  args: [
    { name: "sound", desc: "play a sound file" },
    { name: "notif", desc: "mark the terminal urgent so the wm lights its tag" },
    { name: "both", desc: "play a sound and mark the terminal urgent" },
    { name: "off", desc: "disable stream-finished ping" },
  ],
  handler: (text, state) => {
    const args = pingArgs(text);
    const mode = args[0];
    const rawPath = args.slice(1).join(" ");

    if (!mode) {
      pushSystemMessage(state, formatCurrentPing());
      clearPrompt(state);
      return { type: "handled" };
    }

    if (mode === "off" || mode === "none" || mode === "clear") {
      clearStreamFinishedPing();
      pushSystemMessage(state, "Stream-finished ping disabled.");
      clearPrompt(state);
      return { type: "handled" };
    }

    if (mode === "notif") {
      if (rawPath) {
        pushSystemMessage(state, "Usage: /ping notif");
        clearPrompt(state);
        return { type: "handled" };
      }
      saveStreamFinishedPing("notif", null);
      pushSystemMessage(state, "Stream-finished ping set to notif.");
      clearPrompt(state);
      return { type: "handled" };
    }

    if (mode === "sound" || mode === "both") {
      return configureSoundMode(mode, rawPath || undefined, state);
    }

    pushSystemMessage(state, USAGE);
    clearPrompt(state);
    return { type: "handled" };
  },
};
