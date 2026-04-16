/**
 * Shared chat-area layout measurements.
 *
 * Keeps the prompt/status/search/footer row math in one place so render,
 * resize handling, and tests all agree on the same geometry.
 */

import { getInputLines, type InputLinesResult } from "./promptline";
import { renderStatusLine, type StatusLineResult } from "./statusline";
import type { RenderState } from "./state";
import { getRenderedVoicePrompt } from "./voice";

/** Visible width of the vim mode + prompt prefix (e.g. "N > "). */
export const PROMPT_PREFIX_WIDTH = 4;
const MAX_INPUT_ROWS = 10;
const NON_PROMPT_ROWS = 6;
const MESSAGE_AREA_START_ROW = 3;

export interface BottomLayoutMetrics {
  renderedPrompt: { buffer: string; cursorPos: number };
  maxInputWidth: number;
  input: InputLinesResult;
  inputRowCount: number;
  status: StatusLineResult;
  imageIndicatorRows: number;
  bottomStartRow: number;
  searchBarRow: number;
  promptSepRow: number;
  firstInputRow: number;
  sepBelow: number;
  messageAreaHeight: number;
}

export function computeBottomLayout(state: RenderState, chatW: number, rows: number): BottomLayoutMetrics {
  const maxInputWidth = chatW - PROMPT_PREFIX_WIDTH;
  const maxInputRows = Math.min(MAX_INPUT_ROWS, Math.floor((rows - NON_PROMPT_ROWS) / 2));
  const renderedPrompt = getRenderedVoicePrompt(state.inputBuffer, state.cursorPos, state.voicePrompt);
  const input = getInputLines(
    renderedPrompt.buffer,
    renderedPrompt.cursorPos,
    maxInputWidth,
    maxInputRows,
    state.promptScrollOffset,
  );
  const inputRowCount = input.lines.length;
  const status = renderStatusLine(state, chatW);
  const imageIndicatorRows = state.pendingImages.length > 0 ? 1 : 0;
  const searchBarRows = state.search?.barOpen ? 1 : 0;
  const bottomUsed = searchBarRows + 1 + imageIndicatorRows + inputRowCount + 1 + status.height;
  const bottomStartRow = rows - bottomUsed + 1;
  const searchBarRow = searchBarRows > 0 ? bottomStartRow : 0;
  const promptSepRow = bottomStartRow + searchBarRows;
  const firstInputRow = promptSepRow + 1 + imageIndicatorRows;
  const sepBelow = firstInputRow + inputRowCount;
  const messageAreaHeight = Math.max(0, bottomStartRow - MESSAGE_AREA_START_ROW);

  return {
    renderedPrompt,
    maxInputWidth,
    input,
    inputRowCount,
    status,
    imageIndicatorRows,
    bottomStartRow,
    searchBarRow,
    promptSepRow,
    firstInputRow,
    sepBelow,
    messageAreaHeight,
  };
}
