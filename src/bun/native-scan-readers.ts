import type { NativeDevServerProbe, NativePaneRecordsReader } from "./port-scanner";
import { nativeTaskPaneRoots } from "./port-scanner";
import { nativeTaskIdsOnDisk, nativeTaskPaneRecords } from "./native-task-panes";
import { auxPaneMarker } from "./task-aux-panes";
import { taskTerminalBackendIdentity } from "./task-terminal-backend";
import { devServerScriptBase } from "../shared/dev-servers";

/**
 * The poller's native dev-server read: record files and the shared process tree
 * only. Native recovery (`auxPaneAlive`) is too heavy to run per server per tick.
 */
export const probeNativeDevServer: NativeDevServerProbe = async (task, _socket, serverName, tree) => {
	if (taskTerminalBackendIdentity(task) !== "native") return null;
	const marker = auxPaneMarker(task.id, "devServer", devServerScriptBase(serverName));
	const root = nativeTaskPaneRoots(task.id, tree).find((pane) => pane.command.join(" ").includes(marker));
	return { alive: root !== undefined, rootPid: root?.shellPid ?? null };
};

export const nativePaneRecordsReader: NativePaneRecordsReader = {
	listTaskIds: nativeTaskIdsOnDisk,
	readPanes: nativeTaskPaneRecords,
};
