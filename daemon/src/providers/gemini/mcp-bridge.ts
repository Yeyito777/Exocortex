/**
 * Stdio MCP server the Antigravity CLI starts for an Exocortex conversation
 * (see bridge.ts). It offers the tools the daemon lists and forwards each call
 * to the daemon over EXOCORTEX_GEMINI_SOCKET. Standalone: no imports from the
 * daemon, so it starts fast.
 */

export {};

const socketPath = process.env.EXOCORTEX_GEMINI_SOCKET ?? "";
const token = process.env.EXOCORTEX_GEMINI_TOKEN ?? "";

type Json = Record<string, unknown>;

const out = (message: Json) => process.stdout.write(`${JSON.stringify(message)}\n`);

let nextId = 1;
const waiting = new Map<number, (message: Json) => void>();
let daemonBuffer = "";
let daemon: Awaited<ReturnType<typeof Bun.connect>> | null = null;

async function connect() {
  daemon ??= await Bun.connect({
    unix: socketPath,
    socket: {
      data(_socket, chunk) {
        daemonBuffer += chunk.toString();
        let newline: number;
        while ((newline = daemonBuffer.indexOf("\n")) >= 0) {
          const line = daemonBuffer.slice(0, newline);
          daemonBuffer = daemonBuffer.slice(newline + 1);
          if (!line.trim()) continue;
          const message = JSON.parse(line) as Json;
          const resolve = waiting.get(message.id as number);
          if (resolve) {
            waiting.delete(message.id as number);
            resolve(message);
          }
        }
      },
      close() {
        daemon = null;
        for (const resolve of waiting.values()) resolve({ error: "Exocortex closed the connection." });
        waiting.clear();
      },
    },
  });
  return daemon;
}

async function ask(request: Json): Promise<Json> {
  const socket = await connect();
  const id = nextId++;
  return new Promise(resolve => {
    waiting.set(id, resolve);
    socket.write(`${JSON.stringify({ ...request, id, token })}\n`);
  });
}

async function handle(message: Json): Promise<void> {
  const id = message.id;
  const params = (message.params ?? {}) as Json;
  if (id === undefined || id === null) return; // notifications
  switch (message.method) {
    case "initialize": {
      const listed = await ask({ type: "list" });
      const instructions = ((listed.result ?? {}) as Json).instructions;
      out({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "exocortex", version: "1.0.0" },
          ...(typeof instructions === "string" && instructions ? { instructions } : {}),
        },
      });
      return;
    }
    case "tools/list": {
      const listed = await ask({ type: "list" });
      if (listed.error) {
        out({ jsonrpc: "2.0", id, error: { code: -32603, message: String(listed.error) } });
        return;
      }
      const tools = (((listed.result ?? {}) as Json).tools ?? []) as Json[];
      out({ jsonrpc: "2.0", id, result: { tools: tools.map(tool => ({ ...tool, _meta: { "antigravity/alwaysLoad": true } })) } });
      return;
    }
    case "tools/call": {
      const { toolSummary: _summary, ...args } = (params.arguments ?? {}) as Json;
      const answer = await ask({ type: "call", name: params.name, arguments: args });
      const result = (answer.result ?? null) as { text?: string; isError?: boolean } | null;
      const text = result?.text ?? String(answer.error ?? "The tool returned no result.");
      out({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: result ? result.isError === true : true } });
      return;
    }
    case "ping":
      out({ jsonrpc: "2.0", id, result: {} });
      return;
    default:
      out({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${String(message.method)}` } });
  }
}

let buffer = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message: Json;
    try {
      message = JSON.parse(line) as Json;
    } catch {
      continue;
    }
    handle(message).catch(error => {
      if (message.id !== undefined) out({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
    });
  }
}
process.exit(0);
