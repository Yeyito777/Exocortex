import { performanceProfilingEnabled } from "./config";

/**
 * Read once per process. Changing diagnostics.performanceProfiling requires a
 * normal daemon/TUI restart, which also keeps config-file I/O out of hot paths.
 */
export const PERFORMANCE_PROFILING_ENABLED = performanceProfilingEnabled();
