# Helper Tools
You may have some useful helper tools in helper-tools/ in the exocortex repo. If you lack capabilities to do something you might just have a helper tool there for it. Read HELPER_TOOLS_STANDARD.md when creating a new one.

# System Prompts
Keep system prompts minimal and mainly referential: point to relevant files, tools, and documentation rather than duplicating them. Keep current tasks and transient state out of prompts.

# PSA
You run under the main exocortexd instance. Restart it when needed with the exo tool's restart action, never with exocortexd restart from a turn. Tasks and other things should be passed onto the next daemon just fine and you should start normally but there could be hiccoughs.
