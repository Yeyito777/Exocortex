import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalArchiveContent } from "./canonical-archive-content";

function normalized(content: any[]) {
  const blobs: Array<{ kind: "tool_result" | "image"; payload_json: string }> = [];
  const stub = content.map((part, blockIndex) => {
    if (part.type === "tool_result") {
      blobs.push({ kind: "tool_result", payload_json: JSON.stringify({ blockIndex, value: part.content }) });
      return { ...part, content: "" };
    }
    if (part.type === "image") {
      blobs.push({ kind: "image", payload_json: JSON.stringify({ blockIndex, value: part.source.data }) });
      return { ...part, source: { ...part.source, data: "" } };
    }
    return part;
  });
  const json = JSON.stringify(content);
  return { stub: JSON.stringify(stub), blobs, json, checksum: createHash("sha256").update(json).digest("hex") };
}
test("raw canonical fragments preserve Unicode, escapes, field order and structured results", () => {
  for (const value of ["", "😄汉字\ud800\n\t\\\"", null, [{ type: "text", text: "a" }, { type: "image", source: { data: "xyz" } }], { a: [1, false, null] }]) {
    const fixture = normalized([
      { content: value, tool_use_id: "first", type: "tool_result", is_error: true },
      { type: "text", text: "mixed result" },
      { source: { media_type: "image/png", data: "b64==", type: "base64" }, type: "image" },
      { type: "tool_result", content: "second", tool_use_id: "second" },
    ]);
    expect(canonicalArchiveContent(fixture.stub, fixture.checksum, fixture.blobs)?.parts.join("")).toBe(fixture.json);
  }
});
test("missing, changed, malformed or noncanonical payloads require canonical fallback", () => {
  const fixture = normalized([{ type: "tool_result", content: "original", tool_use_id: "x" }]);
  expect(canonicalArchiveContent(fixture.stub, fixture.checksum, [])).toBeNull();
  for (const payload_json of [
    '{"blockIndex":0,"value":"changed"}', '{"blockIndex":0,"value":"unterminated}',
    '{"value":"original","blockIndex":0}', '{"blockIndex":99,"value":"original"}',
  ]) expect(canonicalArchiveContent(fixture.stub, fixture.checksum, [{ kind: "tool_result", payload_json }])).toBeNull();
});
test("raw checking never decodes a large canonical result body", () => {
  const fixture = normalized([{ type: "tool_result", content: "x".repeat(2_000_000), tool_use_id: "large" }]);
  const parse = JSON.parse;
  JSON.parse = ((text: string, ...args: unknown[]) => {
    expect(text.length).toBeLessThan(1000);
    return parse(text, ...args as []);
  }) as typeof JSON.parse;
  try { expect(canonicalArchiveContent(fixture.stub, fixture.checksum, fixture.blobs)?.parts.join("")).toBe(fixture.json); }
  finally { JSON.parse = parse; }
});
