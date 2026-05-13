/** Prompt-buffer text sanitization.
 *
 * Text that enters the editable prompt is later written directly back to the
 * terminal. If raw terminal controls (for example pasted ANSI color sequences
 * or C1 CSI bytes) are allowed into the buffer, the cursor math counts their
 * bytes/UTF-16 units while the terminal interprets them as zero-width controls.
 * That makes the hardware cursor appear to the right of the visible edit point
 * and can leak replacement/control glyphs into queued messages.
 */

// Common ANSI/control-string forms. This intentionally covers complete escape
// sequences; any orphan control bytes are removed by PROMPT_CONTROL_RE below.
const PROMPT_ESCAPE_SEQUENCE_RE = /(?:\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|\x1b[P^_][\s\S]*?\x1b\\|\x1b[@-Z\\-_])/g;

// Keep LF as the prompt's multiline separator. Tabs are normalized before this
// regex, and CR is normalized to LF, so every remaining C0/C1 control is unsafe
// prompt content.
const PROMPT_CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

/**
 * Convert arbitrary terminal input/paste payloads into safe prompt text.
 *
 * - Preserve user-visible text and newlines.
 * - Normalize tabs to spaces so terminal width accounting stays explicit.
 * - Strip terminal control sequences and stray control bytes instead of storing
 *   them in the prompt buffer.
 */
export function sanitizePromptTextForInsertion(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, "    ")
    .replace(PROMPT_ESCAPE_SEQUENCE_RE, "")
    .replace(PROMPT_CONTROL_RE, "");
}
