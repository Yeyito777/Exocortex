/**
 * Undo/redo stack for the prompt line.
 *
 * Snapshot = buffer + cursor at a point in time.
 * Push before every buffer mutation. Insert mode sessions
 * are grouped into one undo unit (snapshot taken on mode exit).
 *
 * Undo pops the undo stack, pushes current to redo, and restores.
 * Redo pops the redo stack, pushes current to undo, and restores.
 * Any new edit clears the redo stack.
 */

const MAX_UNDO = 200;

export interface Snapshot {
  buffer: string;
  cursor: number;
}

export interface UndoState {
  undoStack: Snapshot[];
  redoStack: Snapshot[];
  /** Buffer state when insert mode was entered — used to group insert sessions. */
  insertEntry: Snapshot | null;
}

export function createUndoState(): UndoState {
  return { undoStack: [], redoStack: [], insertEntry: null };
}

/** Record current state before a buffer mutation. Clears redo stack. */
export function pushUndo(undo: UndoState, buffer: string, cursor: number): void {
  undo.undoStack.push({ buffer, cursor });
  if (undo.undoStack.length > MAX_UNDO) undo.undoStack.shift();
  undo.redoStack.length = 0;
}

/** Called when entering insert mode — saves the entry point. */
export function markInsertEntry(undo: UndoState, buffer: string, cursor: number): void {
  undo.insertEntry = { buffer, cursor };
}

/**
 * Called when leaving insert mode — if buffer changed during insert,
 * push the entry point as one undo unit.
 */
export function commitInsertSession(undo: UndoState, currentBuffer: string): void {
  if (undo.insertEntry && undo.insertEntry.buffer !== currentBuffer) {
    undo.undoStack.push(undo.insertEntry);
    if (undo.undoStack.length > MAX_UNDO) undo.undoStack.shift();
    undo.redoStack.length = 0;
  }
  undo.insertEntry = null;
}

/** Undo: pop last state, push current to redo, return restored state. */
export function undo(state: UndoState, buffer: string, cursor: number): Snapshot | null {
  if (state.undoStack.length === 0) return null;
  state.redoStack.push({ buffer, cursor });
  return state.undoStack.pop()!;
}

/** Redo: pop last redo, push current to undo, return restored state. */
export function redo(state: UndoState, buffer: string, cursor: number): Snapshot | null {
  if (state.redoStack.length === 0) return null;
  state.undoStack.push({ buffer, cursor });
  return state.redoStack.pop()!;
}
