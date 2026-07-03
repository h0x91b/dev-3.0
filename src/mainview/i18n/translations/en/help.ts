/**
 * Inline-help topics (bible §5.4): titles/bodies for HelpCard, rendered from
 * the `HELP_TOPICS` registry in `src/mainview/help.ts`. Bullet lists are one
 * key with "\n"-separated items. UI chrome strings for HelpSpot / help mode
 * live under `help.ui.*`.
 */
const help = {
	// ── UI chrome ──
	"help.ui.aboutSection": "About this section",
	"help.ui.modeBanner": "Help mode — click any highlighted zone to learn what it does",
	"help.ui.exitHint": "Esc to exit",
	"help.ui.whatYouCanDo": "What you can do here",
	"help.ui.explainScreen": "Explain this screen…",
	"help.ui.openShortcuts": "Open keyboard shortcuts",

	// ── Board columns (one topic per status) ──
	"help.board.column.todo.title": "To Do",
	"help.board.column.todo.body":
		"Tasks captured but not started — no worktree, no agent, nothing runs yet. Starting a task gives it an isolated git worktree and a terminal with the agent of your choice.",
	"help.board.column.inProgress.title": "In Progress",
	"help.board.column.inProgress.body":
		"An agent is actively working here. Each task lives in its own git worktree and tmux terminal — click the card to watch it live. Cards move on automatically when the agent finishes or asks something.",
	"help.board.column.userQuestions.title": "User Questions",
	"help.board.column.userQuestions.body":
		"The agent is blocked on you: it asked a question and is waiting. Open the task, answer in the terminal, and the card returns to In Progress by itself. Anything sitting here is a blocker — handle it first.",
	"help.board.column.reviewByAi.title": "AI Review",
	"help.board.column.reviewByAi.body":
		"Work is done and a second agent is reviewing it automatically. No action needed from you — the card moves on by itself when the review completes.",
	"help.board.column.reviewByUser.title": "Your Review",
	"help.board.column.reviewByUser.body":
		"The agent finished and wants your verdict. Open the diff from the task inspector, read the changes, then complete the task — or send it back with comments.",
	"help.board.column.reviewByColleague.title": "PR Review",
	"help.board.column.reviewByColleague.body":
		"The task waits for a teammate's review of its pull request. Track the PR badge on the card; complete the task once the PR lands.",
	"help.board.column.completed.title": "Completed",
	"help.board.column.completed.body":
		"Done and shipped. The task's worktree and terminal were destroyed; its notes, overview and conversation record survive and stay searchable.",
	"help.board.column.cancelled.title": "Cancelled",
	"help.board.column.cancelled.body":
		"Abandoned tasks. Like Completed, the worktree is gone — but the record (notes, overview, history) is kept for future reference.",

	// ── Board chrome ──
	"help.board.filterBar.title": "Search & filters",
	"help.board.filterBar.body":
		"Narrow the board: type to filter cards by title, click label chips to show only matching tasks.",
	"help.board.taskCard.title": "Task card",
	"help.board.taskCard.body":
		"The colored dots are parallel agent variants (each in its own worktree), the bell means the agent is calling you, and the #123 badge is the task's PR with its CI and review state. Right-click the card for every task action.",

	// ── Dashboard ──
	"help.dashboard.projects.title": "Projects",
	"help.dashboard.projects.body":
		"Each project is a git repository with its own Kanban board, labels and lifecycle scripts. An Operations board is a virtual project: its tasks run agents in managed folders, without git.",
	"help.dashboard.statsEntry.title": "Productivity Stats",
	"help.dashboard.statsEntry.body":
		"Your Velocity Cockpit — read-only charts of how much you ship: tasks, lines, velocity, streaks. It celebrates progress; it configures nothing.",
	"help.dashboard.projectRow.title": "Project row",
	"help.dashboard.projectRow.body":
		"The count on the right is agents running now. Colored rows underneath are tasks waiting for you — questions and reviews. Click one to jump straight to that task.",

	// ── Task inspector ──
	"help.inspector.panel.title": "Task inspector",
	"help.inspector.panel.body":
		"The command center for the active task, organized into four zones: task identity (top-left), agents & terminal (top-right), branch & PR (bottom-left), runtime & outputs (bottom-right).",
	"help.inspector.contextBar.title": "Task identity",
	"help.inspector.contextBar.body":
		"Who this task is: its status, labels, and the diff badge — click the badge to open the full diff review. The tests toggle includes or excludes test files from diff counts.",
	"help.inspector.sessionBar.title": "Session & agents",
	"help.inspector.sessionBar.body":
		"Drive who works on the task: drop a second agent into the same session, unleash a swarm of bug hunters, and split, zoom or rearrange tmux panes.",
	"help.inspector.gitBar.title": "Git & PR",
	"help.inspector.gitBar.body":
		"Everything branch-related: view the diff, rebase onto the base branch, push, open a pull request, merge. Git operations run in a visible terminal so you always see what happens.",
	"help.inspector.runtimeBar.title": "Runtime & access",
	"help.inspector.runtimeBar.body":
		"What the task produces and how to reach it: open the worktree in your editor, run package scripts, start or stop the dev server, inspect ports and shared images.",

	// ── Diff viewer ──
	"help.diff.modes.title": "Diff modes",
	"help.diff.modes.body":
		"Uncommitted shows what the agent has not committed yet. Branch shows the whole branch against its base. Unpushed shows commits that have not left for origin.",
	"help.diff.review.title": "Inline review",
	"help.diff.review.body":
		"Drag across the line gutter to comment on a range. Copy review turns all comments into one prompt for the agent — paste it into the task terminal. The review survives restarts for 3 days.",

	// ── Settings sections ──
	"help.settings.agents.title": "Agents",
	"help.settings.agents.body":
		"The coding agents you launch and their presets. Each configuration is a complete launch recipe — model, mode, flags; every task picks one at start. Drag to reorder the picker.",
	"help.settings.appearance.title": "Appearance",
	"help.settings.appearance.body": "Theme, language, zoom and scrolling — how the app looks and feels.",
	"help.settings.behavior.title": "Behavior",
	"help.settings.behavior.body":
		"What happens around your tasks automatically: AI review after an agent finishes, peer review, feature tips, notifications and focus mode.",
	"help.settings.workspace.title": "Workspace",
	"help.settings.workspace.body":
		"Where task worktrees live on disk, which external editors and apps power open-in, and your GitHub accounts.",
	"help.settings.devtools.title": "Developer tools",
	"help.settings.devtools.body": "Terminal keymap presets and the dev3 CLI installation status.",

	// ── Stats ──
	"help.stats.overview.title": "Velocity Cockpit",
	"help.stats.overview.body":
		"Read-only proof of your shipping speed. Gauges and charts re-scope with the range switch; step through past periods with the arrows. Line counts start from the day tracking shipped — no invented history.",

	// ── Modals ──
	"help.modal.createTask.title": "Creating a task",
	"help.modal.createTask.body":
		"The description becomes the agent's prompt. Save parks the task in To Do for later; Run starts an agent on it immediately; Scratch opens a terminal where you explain the goal interactively.",
	"help.modal.launchVariants.title": "Variants",
	"help.modal.launchVariants.body":
		"N variants means N independent agents solving the same task in parallel, each in its own worktree and branch. Compare the results, keep the best one — the rest are cancelled.",

	// ── Header / sidebar ──
	"help.header.utilities.title": "App utilities",
	"help.header.utilities.body":
		"App-wide tools: the coffee cup keeps your machine awake while agents run, the terminal icon manages tmux sessions, and the commit badge pulls fresh commits from the main branch.",
	"help.sidebar.activeTasks.title": "Active tasks",
	"help.sidebar.activeTasks.body":
		"Every task with a live agent, across all projects. Click to jump to it; hover for a live terminal preview.",
} as const;

export default help;
