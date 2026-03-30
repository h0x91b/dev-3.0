export {
	escapeForDoubleQuotes,
	shellQuote,
	buildEnvExports,
	buildCmdScript,
	setPushMessage,
	getPushMessage,
	getPushMessageLocal,
	isActive,
	resolveBinaryPath,
	notifyWatchedTaskStatusChange,
} from "./rpc-handlers/shared";
export {
	startMergeDetectionPoller,
	stopMergeDetectionPoller,
	clearMergeNotification,
	startPRDetectionPoller,
	stopPRDetectionPoller,
	_resetPRPollerState,
	checkOpenPRsForPromotion,
} from "./rpc-handlers/git-operations";
export {
	activateTask,
	handleBellAutoStatus,
	isTaskInProgress,
	runCleanupScript,
	playTaskCompleteSound,
	triggerColumnAgentIfNeeded,
} from "./rpc-handlers/task-lifecycle";
export { resolveOperationalProjectConfig } from "./rpc-handlers/settings-config";
export {
	launchTaskPty,
	launchColumnAgent,
} from "./rpc-handlers/tmux-pty";

import { appHandlers } from "./rpc-handlers/app-handlers";
import { settingsConfigHandlers } from "./rpc-handlers/settings-config";
import { taskLifecycleHandlers } from "./rpc-handlers/task-lifecycle";
import { gitOperationHandlers } from "./rpc-handlers/git-operations";
import { tmuxPtyHandlers } from "./rpc-handlers/tmux-pty";
import { notesLabelsHandlers } from "./rpc-handlers/notes-labels";
import { remoteAccessHandlers } from "./rpc-handlers/remote-access";

export const handlers = {
	...appHandlers,
	...settingsConfigHandlers,
	...taskLifecycleHandlers,
	...gitOperationHandlers,
	...tmuxPtyHandlers,
	...notesLabelsHandlers,
	...remoteAccessHandlers,
};
