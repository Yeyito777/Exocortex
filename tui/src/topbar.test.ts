import { describe, expect, test } from "bun:test";

import { createInitialState } from "./state";
import { visibleLength } from "./textwidth";
import { renderTopbar } from "./topbar";

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("topbar rendering", () => {
  test("keeps wide conversation titles within the requested width", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.sidebar.conversations = [{
      id: "conv-1",
      provider: "openai",
      model: "gpt-5.4",
      effort: "high",
      fastMode: false,
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0,
      title: "【the🦋chat】＆notes",
      marked: false,
      pinned: false,
      streaming: false,
      unread: false,
      sortOrder: 1,
    }];

    const rendered = renderTopbar(state, 40);

    expect(visibleLength(rendered)).toBe(40);
  });

  test("leaves goal state to the task panel", () => {
    const state = createInitialState();
    state.hasChosenProvider = true;
    state.goal = {
      objective: "finish it",
      status: "active",
      pausable: false,
      completable: false,
      createdAt: 1,
      updatedAt: 1,
      turns: 0,
    };

    const rendered = renderTopbar(state, 120);

    expect(rendered).not.toContain("goal:active");
    expect(rendered).not.toContain("--unpausable");
    expect(rendered).not.toContain("--uncompletable");
  });

  test("does not render legacy completed goals", () => {
    const state = createInitialState();
    state.hasChosenProvider = true;
    state.goal = {
      objective: "already done",
      status: "complete",
      createdAt: 1,
      updatedAt: 2,
      turns: 1,
    };

    const rendered = renderTopbar(state, 120);

    expect(rendered).not.toContain("goal:complete");
  });

  test("leaves the SSH alias out of the top bar", () => {
    const state = createInitialState();
    state.sshRemote = { alias: "whale", connected: true };

    const rendered = renderTopbar(state, 40);

    expect(rendered).not.toContain("whale");
    expect(visibleLength(rendered)).toBe(40);
  });

  test("tags the model with the /proxy alias while the provider is proxied", () => {
    const state = createInitialState();
    state.hasChosenProvider = true;
    state.provider = "anthropic";
    state.providerProxies = [{ provider: "anthropic", alias: "whale", state: "connected", remoteLoggedIn: true }];
    expect(stripAnsi(renderTopbar(state, 120))).toContain("— via whale ");

    state.providerProxies = [{ provider: "anthropic", alias: "whale", state: "disconnected", message: "ssh failed" }];
    expect(stripAnsi(renderTopbar(state, 120))).toContain("— via whale (down)");

    state.providerProxies = [{ provider: "openai", alias: "whale", state: "connected", remoteLoggedIn: true }];
    expect(stripAnsi(renderTopbar(state, 120))).not.toContain("via whale");
  });
});
