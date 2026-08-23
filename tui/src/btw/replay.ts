import type { Command, Event } from "../protocol";

export type ReplayableBtwCommand = Extract<Command, { type: "btw_query" | "btw_followup" | "btw_close" }>;
export interface SequencedBtwCommand {
  command: ReplayableBtwCommand;
  sequence: number;
}

export function isBtwMutation(command: Command): command is ReplayableBtwCommand {
  return command.type === "btw_query" || command.type === "btw_followup" || command.type === "btw_close";
}

/** Tracks ambiguous BTW socket writes until the daemon confirms durable state. */
export class BtwMutationReplay {
  private readonly unresolved = new Map<string, SequencedBtwCommand>();

  get size(): number {
    return this.unresolved.size;
  }

  record(command: ReplayableBtwCommand, sequence: number): void {
    // The TUI serializes BTW questions (a new follow-up is accepted only after the
    // prior turn settles), so at most one question mutation per conversation can
    // be ambiguous. A later close intentionally supersedes that pending mutation.
    this.unresolved.set(command.convId, { command, sequence });
  }

  values(): IterableIterator<SequencedBtwCommand> {
    return this.unresolved.values();
  }

  settle(event: Event): void {
    if (!("convId" in event) || typeof event.convId !== "string") return;
    const pending = this.unresolved.get(event.convId);
    if (!pending) return;

    const { command } = pending;
    const mutation = command.type === "btw_query"
      ? "start"
      : command.type === "btw_followup" ? "followup" : "close";
    if (event.type === "btw_mutation_settled"
        && event.mutation === mutation
        && (!command.sessionId || event.sessionId === command.sessionId)
        && (command.type !== "btw_followup" || event.turnId === command.turnId)) {
      this.unresolved.delete(event.convId);
      return;
    }

    // Terminal/session events are compatible acknowledgements for accepted starts
    // and closes. Snapshots alone are deliberately not: persistence failures send
    // an authoritative rollback snapshot while the mutation must remain replayable.
    if (command.type === "btw_query") {
      if ("sessionId" in event && event.sessionId === command.sessionId) {
        this.unresolved.delete(event.convId);
      }
    } else if (command.type === "btw_followup") {
      if ("sessionId" in event
          && event.sessionId === command.sessionId
          && "turnId" in event
          && event.turnId === command.turnId) {
        this.unresolved.delete(event.convId);
      }
    } else if (event.type === "btw_closed"
        && (!command.sessionId || event.sessionId === command.sessionId)) {
      this.unresolved.delete(event.convId);
    }
  }
}
