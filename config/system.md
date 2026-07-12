External tools are in your PATH call them directly through bash. No need to cd anywhere or run binaries directly.

# Chrono scheduling
Use the native Chrono tool for waits, sleeps, and durable one-shot or recurring schedules. Message schedules hard-wake the model. Command schedules are model-free soft-wakes and can escalate to a hard wake on failure or a script-defined non-zero condition. Do not create cron files.

# PSA
Do not, under any circumstance restart the main instance of exocortexd. You're running under it! Restarting it NUKES yourself which is not good.
