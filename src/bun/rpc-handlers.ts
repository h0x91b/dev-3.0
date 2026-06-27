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
	notifyFromCliDesktop,
	consumeRecentWatchedNotification,
	_resetWatchedNotificationState,
	NOTIFICATION_CLICK_TTL_MS,
	setAppForeground,
	isAppForeground,
	setActiveContext,
	getActiveContext,
} from "./rpc-handlers/shared";
export {
	startMergeDetectionPoller,
	stopMergeDetectionPoller,
	clearMergeNotification,
	_resetMergePollerState,
	startPRDetectionPoller,
	stopPRDetectionPoller,
	_resetPRPollerState,
	checkOpenPRsForPromotion,
	_setScheduleRandomForTest,
} from "./rpc-handlers/git-operations";
export {
	activateTask,
	handleBellAutoStatus,
	isTaskInProgress,
	moveTask,
	runCleanupScript,
	emitTaskSound,
	triggerColumnAgentIfNeeded,
} from "./rpc-handlers/task-lifecycle";
export { resolveOperationalProjectConfig } from "./rpc-handlers/settings-config";
export {
	launchTaskPty,
	launchColumnAgent,
	handlePaneExited,
	addVirtualShellPane,
} from "./rpc-handlers/tmux-pty";

import { appHandlers } from "./rpc-handlers/app-handlers";
import { settingsConfigHandlers } from "./rpc-handlers/settings-config";
import { taskLifecycleHandlers } from "./rpc-handlers/task-lifecycle";
import { gitOperationHandlers } from "./rpc-handlers/git-operations";
import { tmuxPtyHandlers } from "./rpc-handlers/tmux-pty";
import { notesLabelsHandlers } from "./rpc-handlers/notes-labels";
import { remoteAccessHandlers } from "./rpc-handlers/remote-access";
import { scriptsHandlers } from "./rpc-handlers/scripts";
import { portTunnelHandlers } from "./rpc-handlers/port-tunnels";
import { conversationSearchHandlers } from "./rpc-handlers/conversation-search-handlers";

export const handlers = {
	...appHandlers,
	...settingsConfigHandlers,
	...taskLifecycleHandlers,
	...gitOperationHandlers,
	...tmuxPtyHandlers,
	...notesLabelsHandlers,
	...remoteAccessHandlers,
	...scriptsHandlers,
	...portTunnelHandlers,
	...conversationSearchHandlers,
};
