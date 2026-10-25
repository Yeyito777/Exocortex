import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { socketPath } from "@exocortex/shared/paths";
import { prepareRestartForReplay, prepareStopWithoutReplay } from "./control";
import { clearActiveGoalRestartMarker, clearInterruptedStreamIds, clearLiveTurns, clearStopRequest, hasActiveGoalRestartMarker, hasFreshStopRequest, liveTurnsPath, STOP_REQUEST_TTL_MS, takeLiveTurnsLeftByUncleanExit, writeLiveTurns, writeStopRequest } from "./restart-markers";
import { existsSync } from "fs";
import { beginDaemonShutdown, getDaemonShutdownMode, resetDaemonShutdownModeForTest } from "./daemon-lifecycle";
import { DaemonServer } from "./server";

let server: DaemonServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
  resetDaemonShutdownModeForTest();
  clearInterruptedStreamIds();
  clearActiveGoalRestartMarker();
  clearStopRequest();
  clearLiveTurns();
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
    expect(hasFreshStopRequest()).toBe(true);
  });

  test("prepare-stop leaves a stop request even when the daemon can't answer its socket", async () => {
    await expect(prepareStopWithoutReplay()).rejects.toThrow();
    // The SIGTERM that `exocortexd stop` sends next still means a real stop.
    expect(hasFreshStopRequest()).toBe(true);
  });

  test("a stop request only answers the signal that follows it", () => {
    const now = Date.now();
    expect(hasFreshStopRequest(now)).toBe(false);
    writeStopRequest(now);
    expect(hasFreshStopRequest(now + 1_000)).toBe(true);
    expect(hasFreshStopRequest(now + STOP_REQUEST_TTL_MS + 1)).toBe(false);
    clearStopRequest();
    expect(hasFreshStopRequest(now)).toBe(false);
  });

  test("turns journaled by a daemon that died without shutting down are taken once", () => {
    writeLiveTurns(["conv-a", "conv-b", "conv-a"]);
    expect(takeLiveTurnsLeftByUncleanExit()).toEqual(["conv-a", "conv-b"]);
    expect(existsSync(liveTurnsPath())).toBe(false);
    expect(takeLiveTurnsLeftByUncleanExit()).toEqual([]);
    writeLiveTurns(["conv-a"]);
    writeLiveTurns([]);
    expect(existsSync(liveTurnsPath())).toBe(false);
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
