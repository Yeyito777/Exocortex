import type { Block } from "../messages";
import type { Event } from "../protocol";
import type { RenderState } from "../state";
import { focusPrompt } from "../state";
import { createRunningBtw, projectConversationBtw } from "./state";

function matchingSession(state: RenderState, sessionId: string) {
  return state.btw?.sessionId === sessionId ? state.btw : null;
}

function currentTextBlock(
  state: RenderState,
  sessionId: string,
  type: "text" | "thinking",
): Extract<Block, { type: "text" }> | Extract<Block, { type: "thinking" }> | null {
  const btw = matchingSession(state, sessionId);
  if (!btw) return null;
  const last = btw.blocks.at(-1);
  if (last?.type === type && (last.type === "text" || last.type === "thinking")) return last;
  const block: { type: "text" | "thinking"; text: string } = { type, text: "" };
  btw.blocks.push(block);
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

    case "btw_snapshot":
      if (!event.btw && state.chatFocus === "btw") focusPrompt(state);
      state.btw = projectConversationBtw(event.convId, event.btw);
      return true;

    case "btw_block_start": {
      const btw = matchingSession(state, event.sessionId);
      if (btw) btw.blocks.push({ type: event.blockType, text: "" });
      return true;
    }

    case "btw_text_chunk":
      {
        const btw = matchingSession(state, event.sessionId);
        const block = currentTextBlock(state, event.sessionId, "text");
        if (btw && block) {
          block.text += event.text;
          btw.text += event.text;
        }
      }
      return true;

    case "btw_thinking_chunk": {
      const block = currentTextBlock(state, event.sessionId, "thinking");
      if (block) block.text += event.text;
      return true;
    }

    case "btw_content":
      {
        const btw = matchingSession(state, event.sessionId);
        if (btw) {
          btw.text = event.text;
          btw.blocks = structuredClone(event.blocks ?? (event.text ? [{ type: "text" as const, text: event.text }] : []));
        }
      }
      return true;

    case "btw_tool_call": {
      const btw = matchingSession(state, event.sessionId);
      if (btw) {
        btw.blocks.push({
          type: "tool_call",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input,
          summary: event.summary,
          ...(event.presentation ? { presentation: event.presentation } : {}),
        });
      }
      return true;
    }

    case "btw_tool_result": {
      const btw = matchingSession(state, event.sessionId);
      if (btw) {
        btw.blocks.push({
          type: "tool_result",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          output: event.output,
          isError: event.isError,
        });
      }
      return true;
    }

    case "btw_status":
      if (state.btw?.sessionId === event.sessionId) state.btw.status = event.status;
      return true;

    case "btw_finished":
      if (state.btw?.sessionId === event.sessionId) {
        state.btw.phase = "complete";
        state.btw.status = "Complete";
        state.btw.endedAt = event.endedAt;
      }
      return true;

    case "btw_error":
      if (state.btw?.sessionId === event.sessionId) {
        state.btw.phase = "error";
        state.btw.status = event.message;
        state.btw.endedAt = event.endedAt;
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
