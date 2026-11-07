import { describe, expect, test } from "bun:test";
import { delay, isTranscribeAudioCommand, isUserMessageDispatchCommand, useVoiceTui, waitFor } from "./testhelpers/voicee2e";

describe("voice recall real TUI flow", () => {
  const launchVoiceTui = useVoiceTui();

  test("SSH: uploaded remote fallback recovers after disconnect and sends final text only once", async () => {
    if (process.platform === "win32") return;
    const { proc, screen, holdSpace, fakeDaemon, localDaemon, stdoutText, stderrText } = await launchVoiceTui("ssh");
    fakeDaemon.broadcast({
      type: "conversation_created", convId: "remote-voice", provider: "openai", model: "gpt-5.5",
      effort: "high", fastMode: false,
    });
    await waitFor(() => fakeDaemon.commands.some(command => command.type === "subscribe" && command.convId === "remote-voice"));
    await holdSpace();
    proc.stdin.write("\r");
    const localRequest = await waitFor(() => localDaemon.commands.find(isTranscribeAudioCommand));
    localDaemon.broadcast({ type: "error", reqId: localRequest.reqId, message: "Fixture local ASR unavailable" });
    const original = await waitFor(() => fakeDaemon.commands.find(isTranscribeAudioCommand));
    fakeDaemon.broadcast({ type: "ack", reqId: original.reqId });
    await waitFor(() => screen.plainRows().some(row => row.includes("Transcribing…")));
    expect(fakeDaemon.commands.filter(isUserMessageDispatchCommand)).toEqual([]);
    fakeDaemon.dropConnections();
    const recovered = await waitFor(() => {
      const requests = fakeDaemon.commands.filter(isTranscribeAudioCommand);
      return requests.length >= 2 ? requests[1] : null;
    });
    expect(recovered).toEqual(original);
    await waitFor(() => fakeDaemon.commands.some(command =>
      command.type === "load_conversation" && command.convId === "remote-voice"));
    await delay(100);
    expect(screen.plainRows().some(row => row.includes("Transcribing…"))).toBe(true);
    fakeDaemon.broadcast({ type: "transcription_result", reqId: original.reqId, text: "recovered remote voice" });
    const sent = await waitFor(() => fakeDaemon.commands.find(command => command.type === "send_message"));
    expect(sent).toMatchObject({
      type: "send_message", convId: "remote-voice", text: "recovered remote voice",
    });
    fakeDaemon.broadcast({ type: "transcription_result", reqId: original.reqId, text: "duplicate remote voice" });
    fakeDaemon.broadcast({ type: "error", reqId: original.reqId, message: "late duplicate fixture error" });
    await delay(250);
    expect(fakeDaemon.commands.filter(isUserMessageDispatchCommand)).toEqual([sent]);
    expect(fakeDaemon.commands.filter(isTranscribeAudioCommand)).toHaveLength(2);
    expect(localDaemon.commands.filter(isUserMessageDispatchCommand)).toEqual([]);
    expect(stdoutText()).not.toContain("duplicate remote voice");
    expect(stdoutText()).not.toContain("late duplicate fixture error");
    expect(stderrText()).not.toContain("Fatal:");
  }, 20_000);
});
