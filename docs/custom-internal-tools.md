# Conversation-scoped internal tools

Exocortex can attach trusted TypeScript or JavaScript internal tools to one
conversation without adding them to the daemon's built-in registry:

```text
/tools enable /absolute/path/to/toolset.ts
/tools enable ~/path/from/your/home/to/toolset.ts
```

Paths beginning with `~/` resolve from the current user's home directory.
Other relative paths resolve from the daemon's working directory. The supported
entry extensions are `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.mjs`, and `.cjs`.

`/tools` also works on a blank chat. In that state, changes belong to the
not-yet-created conversation draft:

- The Tasks panel immediately shows disabled tools and enabled custom tools.
- The policy is applied atomically when the first message creates the
  conversation.
- Opening a different conversation abandons the draft choices and disposes any
  custom tool instances loaded for it.

The module is conversation-scoped. Its schemas, system hints, summaries,
execution behavior, scheduling metadata, deadlines, and display styles use the
same registry path as built-in tools, but its instances are not advertised to or
executable by unrelated conversations.

## Recommended toolset export

Use a default TypeScript export with `apiVersion: 1` and a per-conversation
factory:

```ts
export default {
  apiVersion: 1,
  id: "example.assets",

  create(context) {
    const index = new AssetIndex(context.moduleDirectory);

    return {
      tools: [assetGlob(index), assetGrep(index)],
      async dispose() {
        await index.close();
      },
    };
  },
};
```

The factory receives:

```ts
interface CustomToolModuleContext {
  apiVersion: 1;
  conversationId: string;
  modulePath: string;
  moduleDirectory: string;
  workingDirectory: string;
}
```

Each returned tool implements the same structural interface as a built-in
`Tool` from `daemon/src/tools/types.ts`. A minimal read-only tool looks like:

```ts
const assetGlob = (index): Tool => ({
  name: "asset_glob",
  description: "List assets from the project index.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string" },
      pattern: { type: "string" },
    },
    required: ["kind"],
    additionalProperties: false,
  },
  systemHint: "Use asset_glob to discover asset IDs before editing.",
  parallelSafety: "safe",
  resourceClass: "filesystem_scan",
  display: { label: "Asset Glob", color: "#82aaff" },
  summarize(input) {
    return { label: "Asset Glob", detail: `${input.kind} ${input.pattern ?? ""}`.trim() };
  },
  async execute(input, context, signal) {
    return {
      output: JSON.stringify(await index.glob(input, { signal }), null, 2),
      isError: false,
    };
  },
});
```

For small modules, the default export may instead be one `Tool`, a `Tool[]`, or
an object containing `tools` and an optional `dispose` function. A factory is
recommended when several tools share an index or other per-conversation state.

## Persistence and lifecycle

Enabling a module:

1. Resolves and stores its canonical absolute path.
2. Bundles and hashes its statically imported local source closure, then
   persists that SHA-256 digest and exported tool metadata with the
   conversation.
3. Enables every tool exported by that module.
4. Creates a separate factory result for each conversation.

After a daemon restart, the module is lazily reloaded before the conversation's
next turn. If the module source closure's digest or exported metadata changed, Exocortex
refuses to start that turn instead of silently changing tool behavior. Explicitly
run `/tools enable path/to/toolset.ts` again to review and accept the new version.

Disable one exported tool while retaining the module with:

```text
/tools disable internal:asset_grep
```

Detach the module and all of its tools with:

```text
/tools disable /absolute/path/to/toolset.ts
```

`/tools reset` removes every custom module and restores the conversation's
ordinary default tool policy.

## Trust boundary

Custom modules are executable code, not a sandboxed data format. Only enable
code you trust. Conversation scoping prevents accidental schema/state leakage;
it does not restrict what the module code can do inside the daemon process.
