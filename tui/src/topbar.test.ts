import { describe, expect, test } from "bun:test";

import { createInitialState } from "./state";
import { visibleLength } from "./textwidth";
import { renderTopbar } from "./topbar";

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
});
