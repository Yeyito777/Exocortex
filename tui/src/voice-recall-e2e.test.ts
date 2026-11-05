import { describe, expect, test } from "bun:test";
import { delay, isTranscribeAudioCommand, isUserMessageDispatchCommand, useVoiceTui, waitFor } from "./testhelpers/voicee2e";

describe("voice recall real TUI flow", () => {
  const launchVoiceTui = useVoiceTui();

  for (const route of ["local", "ssh"] as const) {
    test(`${route}: Enter-recalling a submitted transcription ignores the Enter release and keeps completion in the prompt`, async () => {
      if (process.platform === "win32") return; // fake recorder is a POSIX shell fixture
      const { proc, screen, stdoutText, stderrText, fakeDaemon, localDaemon } = await launchVoiceTui(route);
      // Start hold-to-talk from normal mode, release to begin transcribing in the
      // prompt, then press Enter to submit that still-running transcription into
      // chat history. This matches the real workflow that regressed more closely
      // than pressing Enter while the recorder is still active.
      proc.stdin.write("\x1b");
      await delay(30);
      proc.stdin.write("\x1b[32;1:1u");
      await delay(650);
      proc.stdin.write("\x1b[32;1:3u");
      const transcriptionCommand = await waitFor(() => localDaemon.commands.find(isTranscribeAudioCommand));
      proc.stdin.write("\r");
      await delay(120);

      // Reproduce the user's recall path: open Ctrl-W, then press Enter. Real
      // kitty-keyboard terminals send both a press and a release event; the release
      // must not submit the recalled still-transcribing prompt job back to history.
      proc.stdin.write("\x17");
      await waitFor(() => screen.plainRows().some(row => row.includes("Edit message:")));
      proc.stdin.write("\x1b[13;1:1u");
      await delay(20);
      proc.stdin.write("\x1b[13;1:3u");
      await delay(120);

      const sendsBeforeCompletion = fakeDaemon.commands.filter(isUserMessageDispatchCommand);
      expect(sendsBeforeCompletion).toEqual([]);

      localDaemon.broadcast({ type: "transcription_result", reqId: transcriptionCommand.reqId, text: "recalled transcript" });
      await delay(250);

      const sendsAfterCompletion = fakeDaemon.commands.filter(isUserMessageDispatchCommand);
      const rows = screen.plainRows();
      const transcriptRows = rows
        .map((row, index) => ({ row: row.trimEnd(), index }))
        .filter(({ row }) => row.includes("recalled transcript"));
      expect(sendsAfterCompletion).toEqual([]);
      expect(stdoutText()).toContain("recalled transcript");
      expect(transcriptRows).toHaveLength(1);
      expect(transcriptRows[0].index).toBeGreaterThanOrEqual(17);
      expect(stderrText()).not.toContain("Fatal:");
      if (route === "ssh") expect(fakeDaemon.commands.filter(isTranscribeAudioCommand)).toEqual([]);
    }, 10_000);
  }
});
