Use the native `external` runner for managed external tools enabled in the current conversation. When `bash` is also enabled, only the selected managed CLIs are added to its PATH; no `cd` or direct binary path is needed.

# Helper Tools
You may have some useful helper tools in helper-tools/ in the exocortex repo. If you lack capabilities to do something you might just have a helper tool there for it. Read HELPER_TOOLS_STANDARD.md when creating a new one.

# PSA
Do not, under any circumstance restart the main instance of exocortexd. You're running under it! Restarting it NUKES yourself which is not good.
