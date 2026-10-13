import { describe, expect, test } from "bun:test";
import { buildMessageLines, connectionWaitSpinnerText } from "./conversation";
import { handleEvent } from "./events";
import type { DaemonActions } from "./events/types";
import { createPendingAI } from "./messages";
import { clearPendingAI, createInitialState } from "./state";
import { theme } from "./theme";
import { renderTopbar } from "./topbar";

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const daemon = {} as DaemonActions;

describe("waiting for connection", () => {
  test("spinner text shows the time since the turn lost the network", () => {
    expect(connectionWaitSpinnerText(1_000, 1_000)).toBe("⠋ Waiting for connection… 0s");
    expect(connectionWaitSpinnerText(1_000, 1_080)).toBe("⠙ Waiting for connection… 0s");
    expect(connectionWaitSpinnerText(0, 192_000)).toMatch(/^. Waiting for connection… 3m 12s$/);
    expect(connectionWaitSpinnerText(0, 3_723_000)).toMatch(/^. Waiting for connection… 1h 2m 3s$/);
  });

  test("renders in yellow below the streaming turn", () => {
    const state = createInitialState();
    state.pendingAI = createPendingAI(Date.now(), state.model);
    state.connectionWaitStartedAt = Date.now() - 5_000;
    const rendered = buildMessageLines(state, 100).lines;
    const line = rendered.find(entry => entry.includes("Waiting for connection"));
    expect(line?.startsWith(`  ${theme.warning}`)).toBe(true);
    expect(stripAnsi(line!)).toMatch(/Waiting for connection… 5s$/);
    // Gone once the turn moves on.
    state.connectionWaitStartedAt = null;
    expect(buildMessageLines(state, 100).lines.some(entry => entry.includes("Waiting for connection"))).toBe(false);
  });

  test("follows the daemon's events, including a late-joining snapshot", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.pendingAI = createPendingAI(Date.now(), state.model);
    handleEvent({ type: "connection_wait_status", convId: "conv-1", active: true, startedAt: 42 }, state, daemon);
    expect(state.connectionWaitStartedAt).toBe(42);
    // Another conversation's wait does not show here.
    handleEvent({ type: "connection_wait_status", convId: "conv-2", active: false }, state, daemon);
    expect(state.connectionWaitStartedAt).toBe(42);
    handleEvent({ type: "connection_wait_status", convId: "conv-1", active: false }, state, daemon);
    expect(state.connectionWaitStartedAt).toBeNull();

    handleEvent({
      type: "streaming_started", convId: "conv-1", provider: state.provider, model: state.model, startedAt: 1, snapshotKind: "catchup",
      connectionWaitStartedAt: 7,
    }, state, daemon);
    expect(state.connectionWaitStartedAt).toBe(7);
    clearPendingAI(state);
    expect(state.connectionWaitStartedAt).toBeNull();
  });

  test("the top bar says when the daemon is offline", () => {
    const state = createInitialState();
    expect(stripAnsi(renderTopbar(state, 60))).not.toContain("offline");
    handleEvent({ type: "connectivity_status", online: false, offlineSince: 5, nextProbeAt: 8 }, state, daemon);
    expect(state.daemonOfflineSince).toBe(5);
    expect(stripAnsi(renderTopbar(state, 60))).toContain(" Exocortex ⚠ offline");
    handleEvent({ type: "connectivity_status", online: true, offlineSince: null, nextProbeAt: null }, state, daemon);
    expect(stripAnsi(renderTopbar(state, 60))).not.toContain("offline");
  });
});
