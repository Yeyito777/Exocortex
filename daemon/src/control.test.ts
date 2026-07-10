import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { socketPath } from "@exocortex/shared/paths";
import { prepareStopWithoutReplay } from "./control";
import { beginDaemonShutdown, getDaemonShutdownMode, resetDaemonShutdownModeForTest } from "./daemon-lifecycle";
import { DaemonServer } from "./server";

let server: DaemonServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
  resetDaemonShutdownModeForTest();
});

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
});
