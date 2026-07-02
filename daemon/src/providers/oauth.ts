import { createHash, randomBytes } from "crypto";

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

export function browserOpenCommand(url: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") return ["powershell", "-NoProfile", "-Command", `Start-Process "${url}"`];
  return ["xdg-open", url];
}

export async function openUrlInBrowser(url: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(browserOpenCommand(url), { stdout: "ignore", stderr: "ignore" });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}
