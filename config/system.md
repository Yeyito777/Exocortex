External tools are in your PATH call them directly through bash. No need to cd anywhere or run binaries directly.
When building an external integration, use vimbrowser for inspection and add its operational capabilities directly to that external tool; incidental actions on another service, such as retrieving a one-time email code, may use vimbrowser.

# Helper Tools
You may have some useful helper tools in helper-tools/ in the exocortex repo. If you lack capabilities to do something you might just have a helper tool there for it. Read HELPER_TOOLS_STANDARD.md when creating a new one.

# PSA
Do not, under any circumstance restart the main instance of exocortexd. You're running under it! Restarting it NUKES yourself which is not good.
