import type { Event } from "../protocol";
import type { RenderState } from "../state";
import { createRunningBtw, projectConversationBtw } from "./state";

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
      state.btw = projectConversationBtw(event.convId, event.btw);
      return true;

    case "btw_text_chunk":
      if (state.btw?.sessionId === event.sessionId) state.btw.text += event.text;
      return true;

    case "btw_content":
      if (state.btw?.sessionId === event.sessionId) state.btw.text = event.text;
      return true;

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
      if (state.btw?.sessionId === event.sessionId) state.btw = null;
      return true;

    default:
      return false;
  }
}
