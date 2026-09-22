import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { conversationWorkspaceDir } from "@exocortex/shared/paths";
import { parseLocalFileLinkTarget } from "@exocortex/shared/file-links";

export interface ResolvedFileLink {
  path: string;
  kind: "file" | "directory";
  size: number;
}

/** Resolve and validate a local-link destination entirely on the daemon host. */
export async function resolveFileLink(
  conversationId: string,
  target: string,
): Promise<ResolvedFileLink> {
  const parsed = parseLocalFileLinkTarget(target);
  if (parsed === null) throw new Error("Invalid or unsupported local file link");

  const expanded = parsed === "~"
    ? homedir()
    : parsed.startsWith("~/")
      // Concatenation preserves home-relative meaning even for `~//...`;
      // resolve(home, "/...") would otherwise discard the remote home.
      ? resolve(homedir() + parsed.slice(1))
      : parsed;
  const absolute = resolve(conversationWorkspaceDir(conversationId), expanded);
  const canonical = await realpath(absolute);
  const metadata = await stat(canonical);
  const kind = metadata.isFile()
    ? "file"
    : metadata.isDirectory()
      ? "directory"
      : null;
  if (kind === null) throw new Error("Local file link must reference a regular file or directory");

  return { path: canonical, kind, size: metadata.size };
}
