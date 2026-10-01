# Archived tool selection

Retired per-conversation internal/external selection, `/tools`, draft policies,
custom modules, and the former all-in-one native Exocortex runtime.
`.archive` files are reference material, not loaded or tested.

Legacy persistence fields remain readable but do not affect capabilities.
All tool-capable conversations, including subagents, receive the provider's
standard tools and every installed external tool. Parents cannot choose tools.
Current delegation: `daemon/src/tools/exo.ts`; administration: `docs/daemon-ipc.md`.
