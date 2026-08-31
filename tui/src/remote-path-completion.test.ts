import { describe, expect, test } from "bun:test";
import { handlePromptKey } from "./promptline";
import { RemotePathCompletionController } from "./remote-path-completion";
import { createInitialState, type RenderState } from "./state";
import type { PathDirectoryListing } from "./protocol";

interface RequestRecord {
  reqId: string;
  directory: string;
  prefix: string;
}

function setup(now: () => number = Date.now): {
  state: RenderState;
  controller: RemotePathCompletionController;
  requests: RequestRecord[];
} {
  const state = createInitialState();
  state.sshRemote = { alias: "whale", connected: true };
  const requests: RequestRecord[] = [];
  const controller = new RemotePathCompletionController((directory, prefix) => {
    const reqId = `req-${requests.length + 1}`;
    requests.push({ reqId, directory, prefix });
    return reqId;
  }, now);
  controller.setRemoteAlias("whale");
  return { state, controller, requests };
}

function prompt(state: RenderState, text: string): void {
  state.inputBuffer = text;
  state.cursorPos = text.length;
  state.autocomplete = null;
}

function response(
  controller: RemotePathCompletionController,
  state: RenderState,
  reqId: string,
  listings: PathDirectoryListing[],
): void {
  const result = controller.handleEvent({
    type: "path_directory_entries",
    reqId,
    listings,
  }, state);
  expect(result.consumed).toBe(true);
}

describe("remote prompt path completion", () => {
  test("waits for the SSH daemon instead of reading the TUI host", () => {
    const { state, controller, requests } = setup();
    prompt(state, "/rem");

    expect(handlePromptKey(state, { type: "tab" }, controller)).toEqual({ type: "handled" });
    expect(state.inputBuffer).toBe("/rem");
    expect(requests).toEqual([{ reqId: "req-1", directory: "/", prefix: "rem" }]);

    response(controller, state, "req-1", [{
      directory: "/",
      prefix: "rem",
      entries: [{ name: "remote-only", type: "dir" }],
    }]);
    expect(state.inputBuffer).toBe("/remote-only/");
  });

  test("uses daemon lookahead for the next Tab with no extra round trip", () => {
    const { state, controller, requests } = setup();
    prompt(state, "~/W");
    handlePromptKey(state, { type: "tab" }, controller);

    response(controller, state, "req-1", [
      {
        directory: "~/",
        prefix: "W",
        entries: [{ name: "Workspace", type: "dir" }],
      },
      {
        directory: "~/Workspace/",
        prefix: "",
        entries: [{ name: "Projects", type: "dir" }],
      },
    ]);
    expect(state.inputBuffer).toBe("~/Workspace/");
    const requestsAfterHydration = requests.length;

    handlePromptKey(state, { type: "tab" }, controller);
    expect(state.inputBuffer).toBe("~/Workspace/Projects/");
    expect(requests).toHaveLength(requestsAfterHydration);
  });

  test("adds one targeted lookahead request as the first basename character is typed", () => {
    const { state, controller, requests } = setup();
    prompt(state, "~");
    controller.observePrompt(state);
    prompt(state, "~/W");
    controller.observePrompt(state);
    prompt(state, "~/Wor");
    controller.observePrompt(state);

    expect(requests.map(request => ({ directory: request.directory, prefix: request.prefix }))).toEqual([
      { directory: "~/", prefix: "" },
      { directory: "~/", prefix: "W" },
    ]);
  });

  test("partitions cache and pending completions by SSH alias", () => {
    const { state, controller, requests } = setup();
    prompt(state, "~/W");
    handlePromptKey(state, { type: "tab" }, controller);

    controller.setRemoteAlias("dolphin");
    state.sshRemote = { alias: "dolphin", connected: true };
    response(controller, state, "req-1", [{
      directory: "~/",
      prefix: "W",
      entries: [{ name: "WhaleWorkspace", type: "dir" }],
    }]);
    expect(state.inputBuffer).toBe("~/W");

    handlePromptKey(state, { type: "tab" }, controller);
    const dolphinRequest = requests.at(-1)!;
    response(controller, state, dolphinRequest.reqId, [{
      directory: "~/",
      prefix: "W",
      entries: [{ name: "WorkspaceDolphin", type: "dir" }],
    }]);
    expect(state.inputBuffer).toBe("~/WorkspaceDolphin/");

    controller.setRemoteAlias("whale");
    state.sshRemote = { alias: "whale", connected: true };
    prompt(state, "~/W");
    const beforeRehydrate = requests.length;
    handlePromptKey(state, { type: "tab" }, controller);
    expect(state.inputBuffer).toBe("~/WhaleWorkspace/");
    expect(requests).toHaveLength(beforeRehydrate);
  });

  test("completes optimistically from stale cache while refreshing it", () => {
    let time = 1_000;
    const { state, controller, requests } = setup(() => time);
    prompt(state, "/ca");
    handlePromptKey(state, { type: "tab" }, controller);
    response(controller, state, "req-1", [{
      directory: "/",
      prefix: "ca",
      entries: [{ name: "cached", type: "dir" }],
    }]);

    time += 20_000;
    prompt(state, "/ca");
    const before = requests.length;
    handlePromptKey(state, { type: "tab" }, controller);
    expect(state.inputBuffer).toBe("/cached/");
    expect(requests.length).toBeGreaterThan(before);
  });

  test("silently handles an older daemon's correlated unknown-command error", () => {
    const { state, controller } = setup();
    prompt(state, "/remote");
    handlePromptKey(state, { type: "tab" }, controller);

    const result = controller.handleEvent({
      type: "error",
      reqId: "req-1",
      message: "Unknown command: list_path_directory",
    }, state);
    expect(result).toEqual({ consumed: true, uiChanged: false });
    expect(state.inputBuffer).toBe("/remote");
  });
});
