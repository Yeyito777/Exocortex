import { createHash } from "node:crypto";

interface Blob { kind: "tool_result" | "image"; payload_json: string }

/**
 * Hash the original canonical content without decoding/re-escaping huge blob
 * values. The normalized stub is small. Raw values are accepted only after
 * the reconstructed bytes match the content SHA, OR the caller validates the
 * same bytes against the active checkpoint SHA and retries canonically on failure.
 *
 * Noncanonical/legacy envelopes, missing blobs, whitespace edits or corruption
 * return null: the caller must use the original parse/normalize/validate path.
 * This is an optimization, never a new authority or a skipped integrity check.
 */
export function canonicalArchiveContent(
  json: string, checksum: string | undefined, blobs: readonly Blob[], deferToCheckpoint = false,
): { parts: string[]; stub?: unknown[] } | null {
  if (!checksum) return null;
  let stub: unknown[] | undefined;
  let parts = [json];
  if (blobs.length) {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return null;
    stub = parsed;
    const overrides = new Map<number, { field: string; raw: string; image: boolean }>();
    for (const blob of blobs) {
      const match = /^\{"blockIndex":(\d+),"value":/.exec(blob.payload_json);
      if (!match || !blob.payload_json.endsWith("}")) return null;
      const index = Number(match[1]);
      const block = parsed[index];
      if (!block || overrides.has(index)) return null;
      const image = blob.kind === "image";
      if (block.type !== (image ? "image" : "tool_result") || (image && !block.source)) return null;
      overrides.set(index, { field: image ? "data" : "content", raw: blob.payload_json.slice(match[0].length, -1), image });
    }
    const objectParts = (object: Record<string, unknown>, field: string, replacement: string[]): string[] => {
      if (!Object.hasOwn(object, field)) return [];
      const result = ["{"];
      for (const [index, key] of Object.keys(object).entries()) {
        if (index) result.push(",");
        result.push(JSON.stringify(key), ":");
        if (key === field) result.push(...replacement);
        else result.push(JSON.stringify(object[key]));
      }
      result.push("}");
      return result;
    };
    parts = ["["];
    for (let index = 0; index < parsed.length; index++) {
      if (index) parts.push(",");
      const override = overrides.get(index);
      if (!override) { parts.push(JSON.stringify(parsed[index])); continue; }
      const block = parsed[index];
      const replacement = override.image
        ? objectParts(block.source, override.field, [override.raw]) : [override.raw];
      const blockParts = objectParts(block, override.image ? "source" : override.field, replacement);
      if (!replacement.length || !blockParts.length) return null;
      parts.push(...blockParts);
    }
    parts.push("]");
  }
  // Worker-only anchored passes may instead verify the SAME bytes against the
  // active checkpoint's SHA. They must normalize/retry if that check fails;
  // never cache/adopt an unchecked digest as a valid checkpoint.
  if (deferToCheckpoint) return { parts, stub };
  const hash = createHash("sha256").update(parts.join(""));
  return hash.digest("hex") === checksum ? { parts, stub } : null;
}
