/** Floating foreground panel for an ephemeral `/btw` answer. */

import { formatModelDisplayName } from "./messages";
import { markdownWordWrap } from "./markdown";
import type { BtwPanelState } from "./state";
import { padRightToWidth, padVisibleRightToWidth, termWidth, truncateToWidth } from "./textwidth";
import { theme } from "./theme";

const ESC = "\x1b[";
const moveTo = (row: number, col: number) => `${ESC}${row};${col}H`;

export interface BtwPanelRender {
  payload: string;
  width: number;
  height: number;
  top: number;
  left: number;
}

function cleanInline(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1F\x7F]/g, "").replace(/\s+/g, " ").trim();
}

function phaseLabel(btw: BtwPanelState): { text: string; color: string } {
  switch (btw.phase) {
    case "complete": return { text: "✓ complete", color: theme.success };
    case "error": return { text: "✗ error", color: theme.error };
    case "starting": return { text: "◌ starting", color: theme.warning };
    case "running": return { text: "● running", color: theme.accent };
  }
}

export function renderBtwPanel(btw: BtwPanelState, cols: number, rows: number): BtwPanelRender | null {
  if (cols <= 0 || rows <= 0) return null;
  if (cols < 22 || rows < 8) {
    const phase = phaseLabel(btw);
    const label = cols >= 21
      ? ` BTW ${phase.text} · ^Q close`
      : cols >= 10 ? " BTW · ^Q" : "BTW";
    btw.maxScroll = 0;
    btw.viewportRows = 1;
    btw.scrollOffset = 0;
    return {
      payload: moveTo(1, 1) + theme.sidebarBg + phase.color + padRightToWidth(label, cols) + theme.reset,
      width: cols,
      height: 1,
      top: 1,
      left: 1,
    };
  }

  const availableWidth = Math.max(20, cols - 2);
  const desiredWidth = Math.max(44, Math.floor(cols * 0.68));
  const width = Math.min(92, availableWidth, desiredWidth);
  const height = Math.min(rows - 3, Math.max(8, Math.floor(rows * 0.68)));
  const top = 2;
  const left = 2;
  const innerWidth = width - 2;
  const contentWidth = Math.max(1, innerWidth - 2);
  const contentRows = Math.max(1, height - 5); // top, query, separator, footer, bottom
  const panelBg = theme.sidebarBg;
  const outline = theme.accent;
  const phase = phaseLabel(btw);

  const applyPanelBg = (line: string): string => {
    const persistent = line.replaceAll(theme.reset, `${theme.reset}${panelBg}`);
    return `${panelBg}${persistent}${theme.reset}`;
  };
  const contentLine = (text: string): string => applyPanelBg(
    `${outline}│${theme.reset}${panelBg} ${padVisibleRightToWidth(text, contentWidth)} ${outline}│`,
  );

  const model = cleanInline(formatModelDisplayName(btw.model));
  const topBase = `${theme.bold}${outline}╭─${theme.reset}${panelBg} ${theme.bold}${theme.text}BTW${theme.boldOff}`;
  const topRight = `${phase.color}${phase.text}${outline} ─╮`;
  const topBaseWidth = termWidth("╭─ BTW");
  const topRightWidth = termWidth(`${phase.text} ─╮`);
  const modelBudget = Math.max(0, width - topBaseWidth - topRightWidth - 2);
  const visibleModel = modelBudget >= 4 ? truncateToWidth(model, modelBudget - 3) : "";
  const modelPart = visibleModel ? `${theme.muted} · ${visibleModel} ` : " ";
  const modelPartWidth = visibleModel ? termWidth(` · ${visibleModel} `) : 1;
  const topFillWidth = Math.max(0, width - topBaseWidth - modelPartWidth - topRightWidth);
  const lines: string[] = [applyPanelBg(topBase + modelPart + outline + "─".repeat(topFillWidth) + topRight)];

  const query = truncateToWidth(cleanInline(btw.query), Math.max(1, contentWidth - 3));
  lines.push(contentLine(`${theme.accent}${theme.bold}Q${theme.boldOff}${theme.reset}${panelBg}  ${theme.text}${query}`));
  lines.push(applyPanelBg(`${outline}├${"─".repeat(innerWidth)}┤`));

  const wrapped = btw.text
    ? markdownWordWrap(btw.text, contentWidth, panelBg).lines
    : [`${theme.muted}${truncateToWidth(btw.phase === "error" ? "No answer was produced." : btw.status || "Thinking…", contentWidth)}${theme.reset}${panelBg}`];
  const maxScroll = Math.max(0, wrapped.length - contentRows);
  btw.maxScroll = maxScroll;
  btw.viewportRows = contentRows;
  btw.scrollOffset = Math.max(0, Math.min(btw.scrollOffset, maxScroll));
  const start = Math.max(0, wrapped.length - contentRows - btw.scrollOffset);
  const visible = wrapped.slice(start, start + contentRows);
  for (let i = 0; i < contentRows; i++) {
    let line = visible[i] ?? "";
    if (i === 0 && start > 0 && termWidth(line) <= contentWidth - 2) {
      line = `${theme.muted}▲${theme.reset}${panelBg} ${line}`;
    }
    if (i === contentRows - 1 && start + contentRows < wrapped.length && termWidth(line) <= contentWidth - 2) {
      line = `${line}${theme.muted} ▼${theme.reset}${panelBg}`;
    }
    lines.push(contentLine(line));
  }

  const rawStatus = cleanInline(btw.status || phase.text);
  const help = contentWidth >= 34
    ? "j/k scroll · q/^Q close · /btw close"
    : contentWidth >= 20 ? "j/k · ^Q close" : "^Q close";
  const statusWidth = Math.max(0, contentWidth - termWidth(help) - 1);
  const status = truncateToWidth(rawStatus, statusWidth);
  const gap = " ".repeat(Math.max(1, contentWidth - termWidth(status) - termWidth(help)));
  lines.push(contentLine(`${phase.color}${status}${theme.reset}${panelBg}${gap}${theme.muted}${help}`));
  lines.push(applyPanelBg(`${outline}╰${"─".repeat(innerWidth)}╯`));

  let payload = "";
  for (let index = 0; index < lines.length; index++) {
    payload += moveTo(top + index, left) + lines[index];
  }
  return { payload, width, height: lines.length, top, left };
}
