/**
 * Push `agentMessageLogChanged` when a project's message log changes on disk
 * without this instance writing it — an append from another installed dev3, or
 * from an older version.
 *
 * The filesystem mechanics live in `day-file-watch.ts` and are shared with the
 * notification archive; this file is only the project binding. Stopping and
 * append-suppression are that module's API directly (`stopDayFileWatches`,
 * `noteLocalDayFileAppend`) — a per-log alias for each would be two names for
 * one behaviour.
 */

import { watchDayFiles } from "./day-file-watch";
import { getPushMessageLocal } from "./rpc-handlers/shared-pure";

/** Observe projects read by this app, including writes from older installed versions. */
export function watchAgentMessageLog(projectId: string, directory: string): void {
	watchDayFiles(directory, () => {
		getPushMessageLocal()?.("agentMessageLogChanged", { projectId });
	});
}
