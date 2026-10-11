import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { socketPath } from "@exocortex/shared/paths";
import { prepareRestartForReplay, prepareStopWithoutReplay } from "./control";
import { clearActiveGoalRestartMarker, clearInterruptedStreamIds, hasActiveGoalRestartMarker } from "./restart-markers";
import { beginDaemonShutdown, getDaemonShutdownMode, resetDaemonShutdownModeForTest } from "./daemon-lifecycle";
import { DaemonServer } from "./server";

let server: DaemonServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
  resetDaemonShutdownModeForTest();
  clearInterruptedStreamIds();
  clearActiveGoalRestartMarker();
});

async function startFakeDaemon(onCommand: (command: Record<string, any>, reply: (event: Record<string, unknown>) => void) => void): Promise<string[]> {
  const received: string[] = [];
  const path = socketPath();
  mkdirSync(dirname(path), { recursive: true });
  server = new DaemonServer(path, (client, command) => {
    received.push(command.type);
    onCommand(command as Record<string, any>, event => server!.sendTo(client, event as never));
  });
  await server.start();
  return received;
}

describe("daemon service control", () => {
  test("prepare-stop handshakes with the live daemon before the service signal", async () => {
    const path = socketPath();
    mkdirSync(dirname(path), { recursive: true });
    server = new DaemonServer(path, (client, command) => {
      if (command.type !== "prepare_shutdown") return;
      beginDaemonShutdown(command.mode);
      server!.sendTo(client, { type: "ack", reqId: command.reqId });
    });
    await server.start();

    await prepareStopWithoutReplay();

    expect(getDaemonShutdownMode()).toBe("stop");
  });

  test("prepare-restart takes the live daemon's in-process result in one round trip", async () => {
    const received = await startFakeDaemon((command, reply) => {
      if (command.type !== "prepare_shutdown") return;
      expect(command.interruptForReplay).toBe(true);
      reply({ type: "shutdown_prepared", reqId: command.reqId, convIds: ["conv-a"], stillStreaming: [] });
    });

    const result = await prepareRestartForReplay();

    expect(result).toEqual({ convIds: ["conv-a"], stillStreaming: [] });
    expect(received).toEqual(["prepare_shutdown"]);
  });

  test("prepare-restart drives preparation itself when the live daemon only acknowledges", async () => {
    const received = await startFakeDaemon((command, reply) => {
      if (command.type === "prepare_shutdown") reply({ type: "ack", reqId: command.reqId });
      if (command.type === "list_conversations") reply({ type: "conversations_list", reqId: command.reqId, conversations: [] });
    });

    const result = await prepareRestartForReplay();

    expect(result).toEqual({ convIds: [], stillStreaming: [] });
    expect(received).toContain("list_conversations");
    expect(hasActiveGoalRestartMarker()).toBe(true);
  });
});
