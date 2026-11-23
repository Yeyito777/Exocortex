/**
 * Antigravity CLI PreToolUse hook for Exocortex conversations (hooks.ts
 * installs it; bridge.ts answers it). Asks the daemon whether the agent's
 * tool call may run; prints a deny decision, or nothing to leave the call to
 * the CLI's own permissions. Standalone, so it starts fast.
 */

export {};

const socketPath = process.env.EXOCORTEX_GEMINI_SOCKET ?? "";
const token = process.env.EXOCORTEX_GEMINI_TOKEN ?? "";

const input = await Bun.stdin.text();

async function decide(): Promise<string> {
  if (!socketPath || !token) return "";
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(input) as Record<string, unknown>;
  } catch {
    return "";
  }
  return new Promise(resolve => {
    let buffer = "";
    const timer = setTimeout(() => resolve(""), 10_000);
    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(`${JSON.stringify({ id: 1, type: "pretool", token, toolCall: payload.toolCall, cwd: payload.cwd })}\n`);
        },
        data(socket, chunk) {
          buffer += chunk.toString();
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          clearTimeout(timer);
          // Resolve before ending: end() runs close(), which resolves with no decision.
          try {
            const result = (JSON.parse(buffer.slice(0, newline)) as { result?: { decision?: string; reason?: string } }).result;
            resolve(result?.decision ? JSON.stringify({ decision: result.decision, reason: result.reason ?? "" }) : "");
          } catch {
            resolve("");
          }
          socket.end();
        },
        close() {
          clearTimeout(timer);
          resolve("");
        },
      },
    }).catch(() => {
      clearTimeout(timer);
      resolve("");
    });
  });
}

const decision = await decide();
// Bun.write waits for the pipe; process.stdout.write before exit can be dropped.
if (decision) await Bun.write(Bun.stdout, `${decision}\n`);
process.exit(0);
