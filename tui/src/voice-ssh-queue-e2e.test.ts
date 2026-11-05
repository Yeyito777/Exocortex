import { describe, expect, test } from "bun:test";
import { delay, isTranscribeAudioCommand, isUserMessageDispatchCommand, useVoiceTui, waitFor } from "./testhelpers/voicee2e";

describe("voice recall real TUI flow", () => {
  const launchVoiceTui = useVoiceTui();

  test("SSH: recording submission immediately queues a placeholder and sends only final locally transcribed text remotely", async () => {
    if (process.platform === "win32") return;
    const { proc, screen, fakeDaemon, localDaemon, stderrText } = await launchVoiceTui("ssh");
    fakeDaemon.broadcast({
      type: "conversation_created", convId: "remote-voice", provider: "openai", model: "gpt-5.5",
      effort: "high", fastMode: false,
    });
    fakeDaemon.broadcast({
      type: "streaming_started", convId: "remote-voice", provider: "openai", model: "gpt-5.5",
      startedAt: Date.now(),
    });
    await delay(100);
    proc.stdin.write("\x1b");
    await delay(30);
    proc.stdin.write("\x1b[32;1:1u");
    await delay(650);
    // Enter during recording retains the automatic message-end queue behavior.
    proc.stdin.write("\r");
    const transcriptionCommand = await waitFor(() => localDaemon.commands.find(isTranscribeAudioCommand));
    await waitFor(() => screen.plainRows().some(row => row.includes("Transcribing…")));
    expect(fakeDaemon.commands.filter(isUserMessageDispatchCommand)).toEqual([]);

    localDaemon.broadcast({ type: "transcription_result", reqId: transcriptionCommand.reqId, text: "queued local voice" });
    const queued = await waitFor(() => fakeDaemon.commands.find(command => command.type === "queue_message"));
    expect(queued).toMatchObject({
      type: "queue_message", convId: "remote-voice", text: "queued local voice", timing: "message-end",
      queueId: expect.any(String),
    });
    expect(localDaemon.commands.filter(isUserMessageDispatchCommand)).toEqual([]);
    expect(fakeDaemon.commands.filter(isTranscribeAudioCommand)).toEqual([]);
    expect(stderrText()).not.toContain("Fatal:");
  }, 10_000);

  test("SSH: a submitted local transcription survives a remote disconnect and reconnect", async () => {
    if (process.platform === "win32") return;
    const { proc, screen, fakeDaemon, localDaemon, stderrText } = await launchVoiceTui("ssh");
    fakeDaemon.broadcast({
      type: "conversation_created", convId: "remote-voice", provider: "openai", model: "gpt-5.5",
      effort: "high", fastMode: false,
    });
    await delay(100);
    proc.stdin.write("\x1b");
    await delay(30);
    proc.stdin.write("\x1b[32;1:1u");
    await delay(650);
    proc.stdin.write("\r");
    const transcriptionCommand = await waitFor(() => localDaemon.commands.find(isTranscribeAudioCommand));
    await waitFor(() => screen.plainRows().some(row => row.includes("Transcribing…")));
    const connectionsBefore = fakeDaemon.commands.filter(command => command.type === "client_capabilities").length;
    fakeDaemon.dropConnections();
    await waitFor(() => fakeDaemon.commands.filter(command => command.type === "client_capabilities").length > connectionsBefore);
    await waitFor(() => fakeDaemon.commands.some(command => command.type === "load_conversation" && command.convId === "remote-voice"));
    await delay(100); // canonical reload must reattach the pending voice echo
    expect(screen.plainRows().some(row => row.includes("Transcribing…"))).toBe(true);

    localDaemon.broadcast({ type: "transcription_result", reqId: transcriptionCommand.reqId, text: "voice after reconnect" });
    const sent = await waitFor(() => fakeDaemon.commands.find(command => command.type === "send_message"));
    expect(sent).toMatchObject({
      type: "send_message", convId: "remote-voice", text: "voice after reconnect",
    });
    expect(fakeDaemon.commands.filter(isTranscribeAudioCommand)).toEqual([]);
    expect(localDaemon.commands.filter(isUserMessageDispatchCommand)).toEqual([]);
    expect(stderrText()).not.toContain("Fatal:");
  }, 10_000);
});
