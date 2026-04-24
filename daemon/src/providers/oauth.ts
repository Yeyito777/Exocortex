import { createHash, randomBytes } from "crypto";
import { isWindows } from "@exocortex/shared/paths";

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export function generateCodeVerifier(length = 64): string {
  return base64url(randomBytes(length)).slice(0, length);
}

export function generateCodeChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

export function generateState(): string {
  return base64url(randomBytes(32));
}

export async function openUrlInBrowser(url: string): Promise<boolean> {
  const openCmd = isWindows
    ? ["powershell", "-NoProfile", "-Command", `Start-Process "${url}"`]
    : ["xdg-open", url];

  try {
    const proc = Bun.spawn(openCmd, { stdout: "ignore", stderr: "ignore" });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}
