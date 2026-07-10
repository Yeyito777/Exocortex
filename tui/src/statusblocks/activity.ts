/**
 * Focused-conversation activity — active subagents and detached tool tasks.
 */

import type { RenderState } from "../state";
import type { StatusBlock } from "../statusline";
import { termWidth } from "../textwidth";
import { theme } from "../theme";

export function activityBlock(state: RenderState): StatusBlock {
  const conversation = state.convId
    ? state.sidebar.conversations.find(candidate => candidate.id === state.convId)
    : undefined;
  const subagents = conversation?.subagentCount ?? 0;
  const backgroundTasks = conversation?.backgroundTaskCount ?? 0;
  const subagentLabel = "  Subagents: ";
  const backgroundLabel = "  Background tasks: ";
  const subagentValue = String(subagents);
  const backgroundValue = String(backgroundTasks);
  const width = Math.max(
    termWidth(subagentLabel) + termWidth(subagentValue),
    termWidth(backgroundLabel) + termWidth(backgroundValue),
  );

  const row = (label: string, value: string) => {
    const padding = Math.max(0, width - termWidth(label) - termWidth(value));
    return `${theme.muted}${label}${theme.accent}${value}${" ".repeat(padding)}${theme.reset}`;
  };

  return {
    id: "conversation-activity",
    // This is intentionally the first block discarded on narrow terminals.
    priority: -1,
    width,
    height: 2,
    rows: [
      row(subagentLabel, subagentValue),
      row(backgroundLabel, backgroundValue),
    ],
  };
}
