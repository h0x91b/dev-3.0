export {
	escapeForDoubleQuotes,
	shellQuote,
	buildEnvExports,
	portableReadKey,
	buildCmdScript,
	setPushMessage,
	getPushMessage,
	getPushMessageLocal,
	isActive,
	resolveBinaryPath,
	bundledTmuxCandidates,
	tmuxSearchPaths,
	notifyWatchedTaskStatusChange,
	notifyWatchedTaskEvent,
	notifyFromCliDesktop,
	consumeRecentWatchedNotification,
	_resetWatchedNotificationState,
	NOTIFICATION_CLICK_TTL_MS,
	setAppForeground,
	isAppForeground,
	setActiveContext,
	getActiveContext,
	setTerminalFocus,
	setFocusMode,
	isTerminalFocusActive,
	isNotificationSuppressed,
	queueTerminalFocusToast,
	queueTerminalFocusAttention,
	pushCliToast,
	pushCliAttention,
	pushTerminalBell,
	pushCliShowImage,
	pushCliShowArtifact,
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
} from "./lifecycle/activities";
export {
	handleBellAutoStatus,
	isTaskInProgress,
	moveTask,
} from "./rpc-handlers/task-lifecycle";
export { activateTask, runCleanupScript, emitTaskSound } from "./lifecycle/executor";
export { triggerColumnAgentIfNeeded } from "./lifecycle/service";
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
import { productivityStatsHandlers } from "./rpc-handlers/productivity-stats";
import { agentUsageHandlers } from "./rpc-handlers/agent-usage";
import { automationsHandlers } from "./rpc-handlers/automations";
import { pxpipeProxyHandlers } from "./rpc-handlers/pxpipe-proxy";
import { agentAccountHandlers } from "./rpc-handlers/agent-accounts";
import { prCommentsHandlers } from "./rpc-handlers/pr-comments";

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
	...productivityStatsHandlers,
	...agentUsageHandlers,
	...automationsHandlers,
	...pxpipeProxyHandlers,
	...agentAccountHandlers,
	...prCommentsHandlers,
};
