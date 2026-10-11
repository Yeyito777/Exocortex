/**
 * Claude Agent SDK and MCP SDK, loaded on first use.
 *
 * Importing them costs ~110ms, which every daemon boot paid before its socket
 * could answer. Async entry points (turns, relay adoption, usage probes) await
 * loadClaudeSdks(); the synchronous code they reach then uses claudeSdks().
 */

type ClaudeAgentSdk = typeof import("@anthropic-ai/claude-agent-sdk");
type McpServerModule = typeof import("@modelcontextprotocol/sdk/server/mcp.js");
type McpTypesModule = typeof import("@modelcontextprotocol/sdk/types.js");

export interface ClaudeSdks {
  claude: ClaudeAgentSdk;
  mcpServer: McpServerModule;
  mcpTypes: McpTypesModule;
}

let loaded: ClaudeSdks | null = null;
let loading: Promise<ClaudeSdks> | null = null;

export function loadClaudeSdks(): Promise<ClaudeSdks> {
  if (loaded) return Promise.resolve(loaded);
  loading ??= Promise.all([
    import("@anthropic-ai/claude-agent-sdk"),
    import("@modelcontextprotocol/sdk/server/mcp.js"),
    import("@modelcontextprotocol/sdk/types.js"),
  ]).then(([claude, mcpServer, mcpTypes]) => {
    loaded = { claude, mcpServer, mcpTypes };
    return loaded;
  }).finally(() => {
    loading = null;
  });
  return loading;
}

export function claudeSdks(): ClaudeSdks {
  if (!loaded) throw new Error("Claude Agent SDK used before loadClaudeSdks() resolved");
  return loaded;
}
