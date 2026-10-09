import { afterEach, describe, expect, test } from "bun:test";
import { createInitialState } from "./state";
import { clearPreferredProvider } from "./preferences";
import { tryCommand } from "./commands";
import { applyInlineCommands } from "./inlineeffort";
import { getPromptHighlightRanges } from "./prompthighlight";
import { commandCompletions, inlineSlashCompletions, resolveSlashShorthands } from "./slashsearch";

afterEach(clearPreferredProvider);

function fixture() {
  const state = createInitialState();
  state.provider = "openai";
  state.model = "gpt-5.4";
  state.effort = "high";
  state.fastMode = false;
  state.providerRegistry = [
    {
      id: "openai", label: "OpenAI", defaultModel: "gpt-5.4",
      allowsCustomModels: true, supportsFastMode: true,
      models: [
        {
          id: "gpt-5.4", label: "Gpt-5.4", maxContext: 272_000,
          supportedEfforts: ["low", "medium", "high", "xhigh"].map(effort => ({ effort: effort as "high", description: effort })),
          defaultEffort: "high",
        },
        {
          id: "gpt-5.4-mini", label: "Gpt-5.4-mini", maxContext: 272_000,
          supportedEfforts: [{ effort: "high", description: "high" }], defaultEffort: "high",
        },
      ],
    },
    {
      id: "anthropic", label: "Anthropic", defaultModel: "claude-opus-5-5",
      allowsCustomModels: false, supportsFastMode: false,
      models: [
        {
          id: "claude-opus-5-5", label: "Opus-5.5", maxContext: 1_000_000,
          supportedEfforts: [{ effort: "high", description: "high" }], defaultEffort: "high",
        },
        {
          id: "claude-sonnet-5-5", label: "Sonnet-5.5", maxContext: 1_000_000,
          supportedEfforts: [{ effort: "high", description: "high" }], defaultEffort: "high",
        },
      ],
    },
  ];
  return state;
}

describe("slash shorthand resolution", () => {
  test("resolves a unique nested argument", () => {
    const state = fixture();
    expect(resolveSlashShorthands(state, "/model opus")).toBe("/model anthropic claude-opus-5-5");
    expect(resolveSlashShorthands(state, "/model anthropic son")).toBe("/model anthropic claude-sonnet-5-5");
    expect(resolveSlashShorthands(state, "/default-model opus")).toBe("/default-model anthropic claude-opus-5-5");
  });

  test("sends the popup's first option when several match", () => {
    const state = fixture();
    expect(resolveSlashShorthands(state, "/model claude")).toBe("/model anthropic claude-opus-5-5");
    expect(resolveSlashShorthands(state, "/model pus")).toBe("/model anthropic claude-opus-5-5");
    expect(resolveSlashShorthands(state, "/mod opus")).toBe("/model anthropic claude-opus-5-5");
    expect(resolveSlashShorthands(state, "/mod")).toBe("/model");
    expect(resolveSlashShorthands(state, "/model op")).toBe("/model openai");
  });

  test("leaves unmatched and custom arguments unchanged", () => {
    const state = fixture();
    expect(resolveSlashShorthands(state, "/model openai my-custom-model")).toBe("/model openai my-custom-model");
    expect(resolveSlashShorthands(state, "/login deepseek sk-test")).toBe("/login deepseek sk-test");
    expect(resolveSlashShorthands(state, "/home/me/notes.txt what is this")).toBe("/home/me/notes.txt what is this");
  });

  test("a trailing space does not pick a child of the typed command", () => {
    const state = fixture();
    // Submission trims, and the popup's first child of "/model " is a provider.
    expect(resolveSlashShorthands(state, "/model")).toBe("/model");
    expect(resolveSlashShorthands(state, "/model anthropic")).toBe("/model anthropic");
  });

  test("prefers an exactly typed argument over longer matches", () => {
    const state = fixture();
    expect(resolveSlashShorthands(state, "/model openai gpt-5.4")).toBe("/model openai gpt-5.4");
    expect(resolveSlashShorthands(state, "/model mini")).toBe("/model openai gpt-5.4-mini");
    expect(resolveSlashShorthands(state, "/effort h")).toBe("/effort high");
  });

  test("prompt-start commands and macros resolve only when the whole input does", () => {
    const state = fixture();
    expect(resolveSlashShorthands(state, "/goal pa")).toBe("/goal pause");
    expect(resolveSlashShorthands(state, "/goal use the new parser")).toBe("/goal use the new parser");
    expect(resolveSlashShorthands(state, "/exocortex tui")).toBe("/exocortex tui-quality");
    expect(resolveSlashShorthands(state, "/exocortex tui is slow")).toBe("/exocortex tui is slow");
  });

  test("inline commands resolve up to the prose that follows", () => {
    const state = fixture();
    expect(resolveSlashShorthands(state, "please /model opus fix this")).toBe("please /model anthropic claude-opus-5-5 fix this");
    expect(resolveSlashShorthands(state, "please /model claude fix this")).toBe("please /model anthropic claude-opus-5-5 fix this");
    // A provider alone is incomplete inline, so the following prose is never read as a model id.
    expect(resolveSlashShorthands(state, "please /model op fix it")).toBe("please /model anthropic claude-opus-5-5 fix it");
    expect(resolveSlashShorthands(state, "please /model anthropic fix it")).toBe("please /model anthropic fix it");
    expect(resolveSlashShorthands(state, "/model opus /effort h go")).toBe("/model anthropic claude-opus-5-5 /effort high go");
    expect(resolveSlashShorthands(state, "explain /effort levels")).toBe("explain /effort levels");
  });

  test("never rewrites /queue targets", () => {
    const state = fixture();
    state.sidebar.conversations = [{
      id: "conv-fix", provider: "openai", model: "gpt-5.4", effort: "high", fastMode: false,
      createdAt: 1, updatedAt: 1, messageCount: 0, title: "Fix login bug",
      marked: false, pinned: false, streaming: false, unread: false, sortOrder: 1,
    }];
    expect(resolveSlashShorthands(state, "/queue fix")).toBe("/queue fix");
    expect(resolveSlashShorthands(state, "/que fix")).toBe("/que fix");
    expect(resolveSlashShorthands(state, "do it /queue fix")).toBe("do it /queue fix");
  });

  test("resolved text runs as the full command or inline modifier", () => {
    const state = fixture();
    expect(tryCommand(resolveSlashShorthands(state, "/mod opus"), state)).toEqual({ type: "handled" });
    expect(state.provider).toBe("anthropic");
    expect(state.model).toBe("claude-opus-5-5");

    const inline = applyInlineCommands(resolveSlashShorthands(state, "please /model mini fix this"), state);
    expect(inline.error).toBeUndefined();
    expect(inline.text).toBe("please fix this");
    expect(inline.modelSelection).toMatchObject({ provider: "openai", model: "gpt-5.4-mini" });
  });
});

describe("slash shorthand highlighting", () => {
  test("highlights sendable shorthand arguments", () => {
    const state = fixture();
    expect(getPromptHighlightRanges(state, "/model opus")).toEqual([{ start: 0, end: 11 }]);
    expect(getPromptHighlightRanges(state, "/model opus ")).toEqual([{ start: 0, end: 11 }]);
    expect(getPromptHighlightRanges(state, "please /model opus fix")).toEqual([{ start: 7, end: 18 }]);
    expect(getPromptHighlightRanges(state, "/model claude")).toEqual([{ start: 0, end: 13 }]);
    expect(getPromptHighlightRanges(state, "/mod opus")).toEqual([{ start: 0, end: 9 }]);
  });

  test("does not highlight arguments Enter would not resolve", () => {
    const state = fixture();
    expect(getPromptHighlightRanges(state, "/model openai my-custom-model")).toEqual([{ start: 0, end: 29 }]);
    expect(getPromptHighlightRanges(state, "/goal use the new parser")).toEqual([{ start: 0, end: 5 }]);
    expect(getPromptHighlightRanges(state, "/notacommand at all")).toEqual([]);
  });
});

describe("slash completion match ranges", () => {
  test("mark matched words in nested completion names", () => {
    const state = fixture();
    const [anchored] = commandCompletions(state, "/model opus");
    expect(anchored.name).toBe("anthropic claude-opus-5-5");
    expect(anchored.matchRanges).toEqual([{ start: 17, end: 21 }]);

    const [rooted] = commandCompletions(state, "/mod opus");
    expect(rooted.name).toBe("/model anthropic claude-opus-5-5");
    expect(rooted.matchRanges).toEqual([{ start: 1, end: 4 }, { start: 24, end: 28 }]);

    const [inline] = inlineSlashCompletions(state, "/model son");
    expect(inline.name).toBe("anthropic claude-sonnet-5-5");
    expect(inline.matchRanges).toEqual([{ start: 17, end: 20 }]);
  });

  test("listing direct arguments has no match ranges", () => {
    const state = fixture();
    expect(commandCompletions(state, "/model ").every(item => item.matchRanges === undefined)).toBe(true);
  });
});
