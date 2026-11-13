/**
 * One JSON value as one protocol line. JSON.stringify leaves U+2028/U+2029
 * raw, and readline treats them as line breaks, splitting the message.
 */
export function jsonLine(value: unknown): string {
  return `${JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")}\n`;
}
