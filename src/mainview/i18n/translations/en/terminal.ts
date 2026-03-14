const terminal = {
	// TaskTerminal
	"terminal.connecting": "Connecting...",
	"terminal.envError": "Task environment error",
	"terminal.worktreeNotFound": "The task's working directory no longer exists. This can happen when the worktree is removed externally.",
	"terminal.errorPath": "Worktree not found:",
	"terminal.complete": "Complete",
	"terminal.cancelTask": "Cancel Task",
	"terminal.sessionEnded": "Terminal session ended",
	"terminal.sessionEndedDesc": "The terminal process has exited. The worktree and all files are still intact.",
	"terminal.resumeAgentSession": "Resume Session",

	// Tmux hotkey hints
	"tmux.hSplit": "h-split",
	"tmux.vSplit": "v-split",
	"tmux.zoom": "zoom",
	"tmux.title": "tmux Shortcuts",
	"tmux.panes": "Panes",
	"tmux.splitHDesc": "Split horizontally",
	"tmux.splitVDesc": "Split vertically",
	"tmux.zoomDesc": "Zoom pane (toggle)",
	"tmux.closePaneDesc": "Close pane",
	"tmux.selectPaneDesc": "Click on a pane to select it",
	"tmux.resizePaneDesc": "Drag pane border to resize",
	"tmux.keyboardMode": "Keyboard Mode",

	// Tmux Session Manager
	"tmuxSessions.title": "tmux Sessions",
	"tmuxSessions.empty": "No active dev3 sessions",
	"tmuxSessions.sessionCount_one": "{count} session",
	"tmuxSessions.sessionCount_other": "{count} sessions",
	"tmuxSessions.copied": "Copied!",
	"tmuxSessions.kill": "Kill",
	"tmuxSessions.killConfirmTitle": "Kill tmux session",
	"tmuxSessions.killConfirmMessage": "Kill session \"{name}\"? This will terminate all processes in it.",
	"tmuxSessions.killFailed": "Failed to kill session: {error}",
	"tmuxSessions.cleanup": "cleanup",
	"tmuxSessions.killAll": "Kill All",
	"tmuxSessions.killAllConfirmTitle": "Kill all tmux sessions",
	"tmuxSessions.killAllConfirmMessage": "Kill all {count} dev3 tmux sessions? This will terminate all processes in them.",
	"tmuxSessions.refresh": "Refresh",

	// Spawn Agent
	"tmux.spawnExtraAgent": "Spawn Extra Agent",
	"tmux.spawnExtraAgentDesc": "Spawn another agent in a new pane",

	// Ports
	"ports.title": "Ports",
	"ports.empty": "No listening ports",
	"ports.openInBrowser": "Open in browser",
	"ports.copyUrl": "Copy URL",
	"ports.copied": "Copied!",
	"ports.count_one": "{count} port",
	"ports.count_other": "{count} ports",
} as const;

export default terminal;
