import { previewTaskHandoffHandler, spawnAgentInTask } from "./tmux-pty/agent-spawn";
import { spawnBugHuntersInTask } from "./tmux-pty/bug-hunters";
import { checkDevServer, getDevServerStatus, restartDevServer, runDevServer, stopDevServer } from "./tmux-pty/dev-servers";
import { restartTask, resumeTask } from "./tmux-pty/resume";
import { dismissCloneFailures, dismissSetupFailure, rerunSetupScript } from "./tmux-pty/setup-rerun";
import { checkWorktreeState, destroyProjectTerminal, getPortAllocations, getProjectPtyUrl, getPtyUrl, getTaskPorts, getTerminalPreview, openFileBrowser, terminalPtyStats } from "./tmux-pty/terminal-attach";
import { exitCopyModeAllPanes, killTmuxSession, listTmuxSessions, setResourceMonitorBoost, tmuxAltClickMoveCursor, tmuxLayout, tmuxPanesInMode, tmuxSearchCancel, tmuxSearchStep, tmuxSearchUpdate, tmuxWindowNavigate } from "./tmux-pty/tmux-control";

export { resolveBugHunterCompareRef, buildBugHunterPrompt, nativeHunterColumnRatios } from "./tmux-pty/bug-hunters";
export { killDevServerSession, runDevServer, stopDevServer, restartDevServer, getDevServerStatus } from "./tmux-pty/dev-servers";
export { sessionStateOrLostCodexPane, ResumeUnavailableError, taskTerminalAlive, resumeTaskSession } from "./tmux-pty/resume";
export type { ResumeTaskOptions, ResumeTaskSessionOutcome } from "./tmux-pty/resume";
export { launchTaskPty, addVirtualShellPane, launchColumnAgent, cleanupTaskTmuxState, handlePaneExited } from "./tmux-pty/task-launch";
export { tmuxAction, tmuxPaneCount, tmuxKillPane, readPaneLayout, tmuxPaneNavigate } from "./tmux-pty/tmux-control";
export type { PaneLayoutInfo } from "./tmux-pty/tmux-control";

export const tmuxPtyHandlers = {
	terminalPtyStats,
	runDevServer,
	checkDevServer,
	stopDevServer,
	restartDevServer,
	getDevServerStatus,
	openFileBrowser,
	getTerminalPreview,
	checkWorktreeState,
	getPtyUrl,
	getProjectPtyUrl,
	destroyProjectTerminal,
	getTaskPorts,
	getPortAllocations,
	listTmuxSessions,
	setResourceMonitorBoost,
	killTmuxSession,
	tmuxLayout,
	tmuxWindowNavigate,
	tmuxAltClickMoveCursor,
	exitCopyModeAllPanes,
	tmuxPanesInMode,
	tmuxSearchUpdate,
	tmuxSearchStep,
	tmuxSearchCancel,
	spawnAgentInTask,
	previewTaskHandoff: previewTaskHandoffHandler,
	spawnBugHuntersInTask,
	resumeTask,
	restartTask,
	rerunSetupScript,
	dismissSetupFailure,
	dismissCloneFailures,
};
