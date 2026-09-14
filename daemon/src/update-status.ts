import { repoRoot } from "@exocortex/shared/paths";
import { createUpdateStatusChecker } from "@exocortex/shared/updatecheck";

// Imported during daemon startup. Never recapture HEAD after a pull.
export const getDaemonUpdateStatus = createUpdateStatusChecker(repoRoot());
