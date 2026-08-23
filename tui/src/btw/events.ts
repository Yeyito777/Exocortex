import type { Block, ConversationBtwTurn } from "../messages";
import type { Event } from "../protocol";
import type { RenderState } from "../state";
import { focusPrompt } from "../state";
import { createRunningBtw, projectConversationBtw } from "./state";

function matchingSession(state: RenderState, sessionId: string) {
  return state.btw?.sessionId === sessionId ? state.btw : null;
}

function matchingTurn(state: RenderState, sessionId: string, turnId?: string): ConversationBtwTurn | null {
  const btw = matchingSession(state, sessionId);
  if (!btw) return null;
  const id = turnId ?? sessionId;
  return btw.turns.find(turn => turn.id === id) ?? null;
}

function syncPanelFromTurn(state: RenderState, turn: ConversationBtwTurn): void {
  const btw = state.btw;
  if (!btw || btw.turns.at(-1) !== turn) return;
  btw.query = turn.query;
  btw.startedAt = turn.startedAt;
  btw.endedAt = turn.endedAt;
  btw.phase = turn.phase;
  btw.blocks = turn.blocks ?? (turn.blocks = []);
  btw.text = turn.text;
  btw.status = turn.status;
}

function currentTextBlock(
  state: RenderState,
  sessionId: string,
  turnId: string | undefined,
  type: "text" | "thinking",
): Extract<Block, { type: "text" }> | Extract<Block, { type: "thinking" }> | null {
  const turn = matchingTurn(state, sessionId, turnId);
  if (!turn) return null;
  const blocks = turn.blocks ?? (turn.blocks = []);
  const last = blocks.at(-1);
  if (last?.type === type && (last.type === "text" || last.type === "thinking")) return last;
  const block: { type: "text" | "thinking"; text: string } = { type, text: "" };
  blocks.push(block);
  syncPanelFromTurn(state, turn);
  return block;
}

/** Apply a BTW protocol event. Returns true when the event belongs to this feature. */
export function handleBtwEvent(event: Event, state: RenderState): boolean {
  switch (event.type) {
    case "btw_mutation_settled":
      // Consumed by DaemonClient to settle ambiguous socket writes.
      return true;

    case "btw_started":
      state.btw = createRunningBtw(event);
      return true;

    case "btw_followup_started": {
      const btw = matchingSession(state, event.sessionId);
      if (!btw) return true;
      let turn = btw.turns.find(candidate => candidate.id === event.turnId);
      if (!turn) {
        turn = {
          id: event.turnId,
          query: event.query,
          startedAt: event.startedAt,
          endedAt: null,
          phase: "running",
          blocks: [],
          text: "",
          status: "Thinking…",
        };
        btw.turns.push(turn);
      } else {
        turn.query = event.query;
        turn.startedAt = event.startedAt;
        turn.endedAt = null;
        turn.phase = "running";
        turn.blocks = [];
        turn.text = "";
        turn.status = "Thinking…";
      }
      syncPanelFromTurn(state, turn);
      return true;
    }

    case "btw_snapshot":
      if (!event.btw && state.chatFocus === "btw") focusPrompt(state);
      state.btw = projectConversationBtw(event.convId, event.btw);
      return true;

    case "btw_block_start": {
      const turn = matchingTurn(state, event.sessionId, event.turnId);
      if (turn) {
        (turn.blocks ??= []).push({ type: event.blockType, text: "" });
        syncPanelFromTurn(state, turn);
      }
      return true;
    }

    case "btw_text_chunk":
      {
        const turn = matchingTurn(state, event.sessionId, event.turnId);
        const block = currentTextBlock(state, event.sessionId, event.turnId, "text");
        if (turn && block) {
          block.text += event.text;
          turn.text += event.text;
          syncPanelFromTurn(state, turn);
        }
      }
      return true;

    case "btw_thinking_chunk": {
      const turn = matchingTurn(state, event.sessionId, event.turnId);
      const block = currentTextBlock(state, event.sessionId, event.turnId, "thinking");
      if (turn && block) {
        block.text += event.text;
        syncPanelFromTurn(state, turn);
      }
      return true;
    }

    case "btw_content":
      {
        const turn = matchingTurn(state, event.sessionId, event.turnId);
        if (turn) {
          turn.text = event.text;
          turn.blocks = structuredClone(event.blocks ?? (event.text ? [{ type: "text" as const, text: event.text }] : []));
          syncPanelFromTurn(state, turn);
        }
      }
      return true;

    case "btw_tool_call": {
      const turn = matchingTurn(state, event.sessionId, event.turnId);
      if (turn) {
        (turn.blocks ??= []).push({
          type: "tool_call",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input,
          summary: event.summary,
          ...(event.presentation ? { presentation: event.presentation } : {}),
        });
        syncPanelFromTurn(state, turn);
      }
      return true;
    }

    case "btw_tool_result": {
      const turn = matchingTurn(state, event.sessionId, event.turnId);
      if (turn) {
        (turn.blocks ??= []).push({
          type: "tool_result",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          output: event.output,
          isError: event.isError,
        });
        syncPanelFromTurn(state, turn);
      }
      return true;
    }

    case "btw_status":
      {
        const turn = matchingTurn(state, event.sessionId, event.turnId);
        if (turn) {
          turn.status = event.status;
          syncPanelFromTurn(state, turn);
        }
      }
      return true;

    case "btw_finished":
      {
        const turn = matchingTurn(state, event.sessionId, event.turnId);
        if (turn) {
          turn.phase = "complete";
          turn.status = "Complete";
          turn.endedAt = event.endedAt;
          syncPanelFromTurn(state, turn);
        }
      }
      return true;

    case "btw_error":
      {
        const turn = matchingTurn(state, event.sessionId, event.turnId);
        if (turn) {
          turn.phase = "error";
          turn.status = event.message;
          turn.endedAt = event.endedAt;
          syncPanelFromTurn(state, turn);
        }
      }
      return true;

    case "btw_closed":
      if (state.btw?.sessionId === event.sessionId) {
        if (state.chatFocus === "btw") focusPrompt(state);
        state.btw = null;
      }
      return true;

    default:
      return false;
  }
}
