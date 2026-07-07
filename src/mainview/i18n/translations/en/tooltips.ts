// Rich tooltip details (`ttip.*`) — the second, explanatory tier of the
// Tooltip primitive. The first line (content) says WHAT the control is; these
// strings explain WHY it exists and what happens when you use it.
export const tooltips = {
	// Global header
	"ttip.header.navBack":
		"Navigation history works like a browser — every board, task and settings screen you visit becomes a step you can walk back through.",
	"ttip.header.navForward": "Return to the screen you just went back from. The history stack keeps your recent screens in order.",
	"ttip.header.switchProject": "Jump straight to another project's board without going through the dashboard.",
	"ttip.header.updateReady": "A new version is downloaded and ready. Click to restart the app and apply it.",
	"ttip.header.quickShell":
		"A throwaway terminal for quick one-off commands. It runs as a scratch task in the Operations board, so nothing touches your project worktrees.",
	"ttip.header.projectTerminal": "A terminal in this project's root folder — the main working tree, not a task worktree.",
	"ttip.header.remoteAccess":
		"Serve this app to your phone or another browser through a secure tunnel. Watch agents and answer their questions from anywhere.",
	"ttip.header.stats": "Tasks completed, lines changed and agent velocity over time — per project and overall.",
	"ttip.header.github": "Open this project's GitHub repository in your browser.",
	"ttip.header.reportBug": "Something in dev-3.0 misbehaves? File a GitHub issue right from here.",
	"ttip.header.changelog": "What's new in dev-3.0 — features and fixes grouped by release day.",
	"ttip.header.moreActions": "Actions that don't fit the toolbar at this window width live here.",
	"ttip.header.tmuxSessions": "Long-running dev3 tmux sessions on this machine. Click to view, attach or kill them.",
	"ttip.header.projectSettings":
		"Everything project-level: lifecycle scripts, base branch, port allocation, custom columns, AI review.",
	"ttip.header.globalSettings": "App-wide preferences: agents, appearance, behavior, language and integrations.",
	"ttip.header.helpMode":
		"Turns on help mode: every zone of the current screen gets an (i) badge — click one to learn what that area does and how to use it.",

	// Task card
	"ttip.task.openPR": "Shows the pull request state at a glance — open, merged or closed. Click to view it on GitHub.",
	"ttip.task.ci": "Live CI status of this task's pull request. Click to open the checks on GitHub.",
	"ttip.task.review": "Review state of the pull request — approved, changes requested, or still waiting for a reviewer.",
	"ttip.task.showDescription": "Read the full task description without opening the task.",
	"ttip.task.cancel":
		"Stops the agent and removes the task's worktree (after the cleanup script runs). The card moves to Cancelled.",
	"ttip.task.delete": "Removes this cancelled task from the board for good.",
	"ttip.task.watch":
		"Watched tasks notify you when the agent finishes, fails or asks a question — so you can safely step away.",
	"ttip.task.siblings":
		"This task has sibling variants — independent agents trying the same job in parallel. Each dot is one sibling's status; click to jump between them.",
	"ttip.task.ports":
		"Network ports allocated to this task. Every task gets its own ports, so parallel dev servers never collide.",
	"ttip.task.run": "Creates the git worktree, opens the terminal and launches the agent on this task.",
	"ttip.task.addVariant":
		"Launches one more agent on the same task in its own worktree. Variants explore independently — compare the results and keep the best.",

	// Task info panel
	"ttip.infoPanel.includeTests":
		"When off, test files are excluded from the diff view and the +/− counters — you see the production-code footprint only.",
	"ttip.infoPanel.showDiff": "Everything this task changed, compared against the base branch.",
	"ttip.infoPanel.spawnAgent":
		"Adds one more agent pane to this task's tmux window. Both agents share the same worktree — handy for a helper or a reviewer.",
	"ttip.infoPanel.bugHunters":
		"Launches several read-only agents that comb this worktree for bugs in parallel and report what they find. They cannot modify files.",
	"ttip.infoPanel.worktreeConfig": "Per-task overrides for how this worktree is set up.",
	"ttip.infoPanel.copyPath": "Copies the absolute path of this task's git worktree — paste it into any terminal or editor.",
	"ttip.infoPanel.actions": "All task actions in one sheet: git, scripts, dev server, open-in and more.",
	"ttip.infoPanel.fullScreen": "The terminal takes over the whole window. Press again to come back.",
	"ttip.infoPanel.expand": "Opens the full info panel: git actions, scripts, dev server and runtime controls.",
	"ttip.infoPanel.collapse": "Shrinks the info panel back to a single compact row.",

	// tmux pane controls
	"ttip.tmux.splitH":
		"tmux: splits the current pane in two, side by side. Run a shell, a log tail or a second tool next to the agent.",
	"ttip.tmux.splitV": "tmux: splits the current pane in two, stacked — the new pane opens below the active one.",
	"ttip.tmux.nextLayout": "tmux: cycles through the preset pane layouts (even columns, rows, tiled…) for this window.",
	"ttip.tmux.chooseLayout": "tmux: pick an exact pane layout from the list instead of cycling through them.",
	"ttip.tmux.zoom":
		"tmux: temporarily maximizes the active pane to the whole window. Press again to restore the layout — nothing is closed.",
	"ttip.tmux.closePane":
		"tmux: closes a pane and terminates whatever runs inside. A picker opens first, so you choose exactly which pane dies.",

	// Git bar
	"ttip.git.changeRef": "Change comparison branch",
	"ttip.git.refDropdown":
		"Choose which branch the diff and the ahead/behind counters compare against — usually the base branch you'll merge into.",
	"ttip.git.rebase": "Replays this task's commits on top of the latest base branch. Keeps the diff honest and surfaces conflicts early.",
	"ttip.git.push": "Publishes the task branch to the remote. The first push creates the remote branch.",
	"ttip.git.createPR": "Opens a pull request from this task's branch. The card badge then tracks its CI and review state.",
	"ttip.git.autoMerge": "GitHub merges the pull request automatically once checks pass and required reviews are in.",
	"ttip.git.merge": "Merges this task's branch into the base branch.",
	"ttip.git.refresh": "Re-checks the branch right now: ahead/behind counts, PR, CI and review state.",

	// Open in / files
	"ttip.openIn.menu": "Open this task's worktree in your editor, terminal, file manager or on GitHub.",
	"ttip.openIn.fileBrowser": "Browse the worktree files in a terminal file manager (yazi), right in a pane next to the agent.",

	// Scripts / dev server / ports / images
	"ttip.scripts.run": "Runs a package.json script or Makefile target from this worktree in a tmux pane, so you watch the output live.",
	"ttip.devServer":
		"Starts the project's dev script in its own tmux window, on ports allocated to this task — parallel tasks never fight over a port.",
	"ttip.sharedImages": "Screenshots, QA captures and diagrams the agent shared with you for this task. Click to view them.",
	"ttip.ports.copyUrl": "Copies the public tunnel URL for this port — share it or open it on another device.",
	"ttip.ports.section": "Ports this task listens on: open them in the browser or expose them through the remote tunnel.",
};
