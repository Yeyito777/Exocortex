import { describe, expect, test } from "bun:test";
import type { ApiToolCall } from "../api";
import {
  getToolDefaultTimeoutMs,
  getToolParallelSafety,
  getToolResourceClass,
  planToolExecutionBatches,
  registryInternalsForTest,
  toolCallsRequireWatchdogPause,
} from "./registry";
import { toolTimeoutReason } from "../abort";

function call(name: string, id = name): ApiToolCall {
  return { id, name, input: {} };
}

describe("tool execution scheduling", () => {
  test("marks read-only tools as parallel-safe and mutating tools as exclusive", () => {
    expect(getToolParallelSafety("read")).toBe("safe");
    expect(getToolParallelSafety("glob")).toBe("safe");
    expect(getToolParallelSafety("grep")).toBe("safe");
    expect(getToolParallelSafety("browse")).toBe("safe");

    expect(getToolParallelSafety("bash")).toBe("exclusive");
    expect(getToolParallelSafety("write")).toBe("exclusive");
    expect(getToolParallelSafety("edit")).toBe("exclusive");
    expect(getToolParallelSafety("patch")).toBe("exclusive");
    expect(getToolParallelSafety("context")).toBe("exclusive");
    expect(getToolParallelSafety("unknown_tool")).toBe("exclusive");
  });

  test("batches adjacent safe tools while keeping exclusive calls ordered", () => {
    const batches = planToolExecutionBatches([
      call("read", "1"),
      call("grep", "2"),
      call("edit", "3"),
      call("glob", "4"),
      call("browse", "5"),
      call("bash", "6"),
      call("read", "7"),
    ]);

    expect(batches.map(batch => ({
      mode: batch.mode,
      names: batch.calls.map(c => c.name),
    }))).toEqual([
      { mode: "parallel", names: ["read", "grep"] },
      { mode: "exclusive", names: ["edit"] },
      { mode: "parallel", names: ["glob", "browse"] },
      { mode: "exclusive", names: ["bash"] },
      { mode: "parallel", names: ["read"] },
    ]);
  });

  test("assigns bounded deadlines and shared scan resources", () => {
    expect(getToolDefaultTimeoutMs("glob")).toBe(30_000);
    expect(getToolDefaultTimeoutMs("grep")).toBe(45_000);
    expect(getToolDefaultTimeoutMs("browse")).toBe(120_000);
    expect(getToolDefaultTimeoutMs("bash")).toBeNull();
    expect(getToolResourceClass("glob")).toBe("filesystem_scan");
    expect(getToolResourceClass("grep")).toBe("filesystem_scan");
    expect(getToolResourceClass("read")).toBeUndefined();
  });

  test("pauses the stream watchdog only for independently managed long-running tools", () => {
    expect(toolCallsRequireWatchdogPause([call("glob")])).toBe(false);
    expect(toolCallsRequireWatchdogPause([call("grep"), call("read")])).toBe(false);
    expect(toolCallsRequireWatchdogPause([call("glob"), call("bash")])).toBe(true);
  });

  test("waits for settle-on-abort tools before returning a timeout", async () => {
    const controller = new AbortController();
    let finishTool!: () => void;
    const toolPromise = new Promise<{ output: string; isError: boolean }>(resolve => {
      finishTool = () => resolve({ output: "No files were changed before the patch stopped.", isError: true });
    });
    let returned = false;
    const execution = registryInternalsForTest.execTool(
      call("patch", "settled-timeout"),
      toolPromise,
      controller.signal,
      true,
    ).then(result => {
      returned = true;
      return result;
    });

    controller.abort(toolTimeoutReason("patch", 30_000));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(returned).toBe(false);

    finishTool();
    const result = await execution;
    expect(returned).toBe(true);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('Tool "patch" timed out');
    expect(result.output).toContain("No files were changed before the patch stopped.");
  });
});
