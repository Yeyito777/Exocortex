import { fileURLToPath } from "node:url";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const URI_SCHEME = /^[a-z][a-z\d+.-]*:/i;

/**
 * Decode a local Markdown-link destination without accepting unsupported URI
 * schemes, network paths, URL query/fragment suffixes, or control characters.
 *
 * The returned path retains relative and `~/` spelling. The filesystem owner
 * must resolve those forms in its own host context. `file://localhost` is local
 * to that owner, just like an authority-free file URL.
 */
export function parseLocalFileLinkTarget(target: string): string | null {
  if (!target || CONTROL_CHARACTERS.test(target)
    || target.startsWith("#") || target.startsWith("//")) return null;

  let path: string;
  try {
    if (/^file:/i.test(target)) {
      const url = new URL(target);
      if ((url.hostname && url.hostname !== "localhost") || url.search || url.hash) return null;
      path = fileURLToPath(url);
    } else {
      if (URI_SCHEME.test(target)) return null;
      path = decodeURIComponent(target);
    }
  } catch {
    return null;
  }

  if (!path.trim() || CONTROL_CHARACTERS.test(path)
    || path.startsWith("//") || URI_SCHEME.test(path)) return null;
  return path;
}
