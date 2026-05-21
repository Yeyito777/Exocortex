import { describe, expect, test } from "bun:test";
import { executeBashBackgroundable, spillAndPreviewForTest } from "./bash";

function makeLargeOutput(): string {
  const lines: string[] = [];
  for (let i = 0; i < 600; i++) {
    lines.push(`line ${i.toString().padStart(4, "0")} ${"x".repeat(80)}`);
  }
  return lines.join("\n");
}

describe("bash spill preview", () => {
  test("includes spill path instructions when temp write succeeds", () => {
    const written: Array<{ path: string; contents: string }> = [];
    const output = spillAndPreviewForTest(makeLargeOutput(), false, (path, contents) => {
      written.push({ path, contents });
    });

    expect(written).toHaveLength(1);
    expect(output).toContain("Full output: ");
    expect(output).toContain("Use the read tool with offset/limit to browse.");
    expect(output).toContain("lines omitted");
  });

  test("honors a smaller inline output budget", () => {
    const written: Array<{ path: string; contents: string }> = [];
    const full = makeLargeOutput();
    const output = spillAndPreviewForTest(full, false, (path, contents) => {
      written.push({ path, contents });
    }, 4_000);

    expect(written).toHaveLength(1);
    expect(written[0].contents).toBe(full);
    expect(output.length).toBeLessThan(6_000);
    expect(output).toContain("Full output: ");
    expect(output).toContain("line 0000");
    expect(output).toContain("line 0599");
  });

  test("degrades gracefully when temp write fails", () => {
    const output = spillAndPreviewForTest(makeLargeOutput(), true, () => {
      throw new Error("EDQUOT: quota exceeded");
    });

    expect(output).toContain("Full output could not be written to a temp file");
    expect(output).toContain("EDQUOT: quota exceeded");
    expect(output).toContain("byte-truncated at 1MB");
    expect(output).not.toContain("Use the read tool with offset/limit to browse.");
  });
});

describe("bash inline output budget", () => {
  test("spills medium output at the default budget", async () => {
    const result = await executeBashBackgroundable(
      { command: "yes x | head -c 13000" },
      undefined,
      60_000,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("Full output: ");
    expect(result.output).toContain("Use the read tool with offset/limit to browse.");
  });

  test("allows larger inline output when max_output_chars is raised", async () => {
    const result = await executeBashBackgroundable(
      { command: "yes x | head -c 13000", max_output_chars: 20_000 },
      undefined,
      60_000,
    );

    expect(result.isError).toBe(false);
    expect(result.output).not.toContain("Full output: ");
    expect(result.output.length).toBe(13_000);
  });
});

describe("bash manual backgrounding", () => {
  test("registered backgrounder resolves a running command immediately", async () => {
    let background: (() => boolean) | null = null;

    const promise = executeBashBackgroundable(
      { command: "echo start; sleep 0.2; echo done", await: 60 },
      undefined,
      60_000,
      {
        toolCallId: "call-bash-1",
        registerBackgrounder: (backgrounder) => {
          background = backgrounder?.background ?? null;
        },
      },
    );

    for (let i = 0; i < 20 && !background; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    expect(background).toBeTruthy();
    expect(background!()).toBe(true);

    const result = await promise;
    expect(result.isError).toBe(false);
    expect(result.output).toContain("start");
    expect(result.output).toContain("Command backgrounded on user request");
    expect(result.output).toContain("Output is being written to:");
    expect(background).toBeNull();
  });
});
