// Markdown rendering for the Exocortex TUI.
// Re-exports public APIs from the markdown subsystem.

// Primary entry point — wraps, formats, and renders markdown text
export { markdownWordWrap } from "./wordwrap";

// Inline formatting and width utilities
export { formatMarkdown, formatMarkdownChunks, stripMarkdown, visibleLength, termWidth, sliceByWidth, hardBreak, isHorizontalRule } from "./formatting";

// Syntax highlighting
export { highlightLine, isLanguageSupported } from "./highlight";

// Fenced code blocks
export { isCodeBlockLine, CODE_GUTTER, FENCE_OPEN_RE, isFenceClose, renderCodeBlock } from "./codeblocks";

// Tables
export { isTableLine, isTableSeparator, isBoxDrawingLine, renderTableBlock } from "./tables";
