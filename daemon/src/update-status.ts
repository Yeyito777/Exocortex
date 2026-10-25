import { repoRoot } from "@exocortex/shared/paths";
import { createUpdateStatusChecker, createUpdateStatusService, type UpdateStatus } from "@exocortex/shared/updatecheck";

// Imported during daemon startup. Never recapture HEAD after a pull.
const updateStatus = createUpdateStatusService(repoRoot(), createUpdateStatusChecker(repoRoot()));

/** Fresh as of the request: a changed checkout is classified again first. */
export const getDaemonUpdateStatus = (): Promise<UpdateStatus> => updateStatus.current();
/** Without waiting: null until the first check finished. */
export const peekDaemonUpdateStatus = (): UpdateStatus | null => updateStatus.peek();
export const onDaemonUpdateStatusChange = (listener: (status: UpdateStatus) => void): () => void => updateStatus.subscribe(listener);
/** Daemon startup: keep the status warm so a connecting client gets it at once. */
export const startDaemonUpdateStatus = (): void => updateStatus.start();
export const stopDaemonUpdateStatus = (): void => updateStatus.stop();
