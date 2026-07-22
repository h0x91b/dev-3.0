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
		"One box searches and filters the board. Type free text to fuzzy-match titles/descriptions, or filter with tokens — priority:P0 label:\"Bug Fix\" agent:Codex status:review is:attention has:port. The P0–P4 priority chips, the label chips and the funnel dropdown all edit these same tokens, so typing and clicking never disagree. The × clears everything. Manage labels in Project Settings → Labels.",
	"help.board.priorityFilter.title": "Priority filter",
	"help.board.priorityFilter.body":
		"Every task has a priority P0 (highest) … P4 (lowest, default P3). Columns always sort by it, so the most important work stays on top. Click a chip to show only that priority; drag a card into another band to re-prioritize it.",
	"help.filters.dsl.title": "Search & filters",
	"help.filters.dsl.body":
		"Type to fuzzy-match titles and descriptions, or filter with tokens: priority:P0 label:\"Bug Fix\" agent:Codex status:review is:attention has:port. Quote multi-word values. Combine facets (AND); repeat one facet to broaden (OR). The P0–P4 chips, label chips and the funnel all edit these same tokens. Manage labels in Project Settings → Labels.",
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
	"help.inspector.metadata.title": "Task details",
	"help.inspector.metadata.body":
		"Identity of this task: its description (the agent's prompt), the worktree path on disk — copy it to cd there yourself — and when it was created and last touched.",
	"help.inspector.notes.title": "Notes",
	"help.inspector.notes.body":
		"A durable scratchpad for this task. Notes survive after the task completes and its worktree is destroyed, and future agents can search them — so record decisions and hard-won findings here, not just reminders.",

	// ── Diff viewer ──
	"help.diff.modes.title": "Diff modes",
	"help.diff.modes.body":
		"Uncommitted shows what the agent has not committed yet. Branch shows the whole branch against its base. Unpushed shows commits that have not left for origin. Recent commits shows just the last commit — click the ▾ to view the last 2, 3, 5, or 10 — clamped to this branch's own commits.",
	"help.diff.review.title": "Inline review",
	"help.diff.review.body":
		"Drag across the line gutter to comment on a range. Copy puts the whole review on your clipboard as one prompt; Send types it straight into the agent — the one you last focused when several are running, otherwise the focused pane. The review survives restarts for 3 days.",
	"help.diff.filesAside.title": "Files",
	"help.diff.filesAside.body":
		"Every changed file with its read progress. Tick a file off as you review it — the counter fills as you go. Expand or collapse all files, mark them all read, or click one to jump to it in the diff.",
	"help.diff.githubReview.title": "PR conversation",
	"help.diff.githubReview.body":
		"When the task has a pull request, its GitHub review threads show here and inline on the code — read-only. Toggle resolved threads, refresh, or open any comment on GitHub. Send a thread to the agent as a fix prompt; this surface never writes back to GitHub.",

	// ── Settings sections ──
	"help.settings.agents.title": "Agents",
	"help.settings.agents.body":
		"The coding agents you launch and their presets. Each configuration is a complete launch recipe — model, mode, flags; every task picks one at start. Drag to reorder the picker.",
	"help.settings.appearance.title": "Appearance",
	"help.settings.appearance.body": "Theme, language, zoom and scrolling — how the app looks and feels.",
	"help.settings.tasks.title": "Tasks & Board",
	"help.settings.tasks.body":
		"Board and task behavior defaults: where a dropped card lands in its column, the task-completion sound, focus mode, watch-by-default, and feature tips.",
	"help.settings.terminal.title": "Terminal",
	"help.settings.terminal.body":
		"How the terminal feels: the keyboard preset (Default or iTerm2-style), scroll speed, and zoom reset.",
	"help.settings.accounts.title": "Agent accounts",
	"help.settings.accounts.body":
		"Sign in to multiple accounts per agent (Claude Code, Codex), switch which one is active, and manage API-key profiles.",
	"help.settings.system.title": "System",
	"help.settings.system.body":
		"App-level machinery: the update channel, keeping the machine awake while agents work, quit confirmation, and browser notifications.",
	"help.settings.workspace.title": "Workspace",
	"help.settings.workspace.body":
		"Where task worktrees live on disk, which external editors and apps power open-in, and your GitHub accounts.",
	"help.settings.devtools.title": "Developer tools",
	"help.settings.devtools.body": "Terminal keymap presets and the dev3 CLI installation status.",
	"help.settings.rateLimits.title": "Rate-limit tracking",
	"help.settings.rateLimits.body":
		"Show live Claude/Codex rate-limit usage in the header, so you see a limit coming before it stalls your agents. The percent turns yellow near the cap; toggle it off if you don't want the indicator.",
	"help.settings.pxpipe.title": "Token-saving proxy",
	"help.settings.pxpipe.body":
		"An experimental local proxy (pxpipe) that renders bulky context as images to cut input tokens — often ~2× cheaper, a little slower. Off by default; enabling it unlocks the \"Fable 5 (cost trick)\" preset.",

	// ── Project settings (tabs) ──
	"help.projectSettings.board.title": "Board configuration",
	"help.projectSettings.board.body":
		"Board-level setup for this project: the custom Kanban columns tasks can move through, and the labels you can tag tasks with.",
	"help.projectSettings.project.title": "Project configuration",
	"help.projectSettings.project.body":
		"Repo-wide settings: the setup / dev / cleanup scripts, the default base branch, the GitHub account, and whether AI review runs automatically.",
	"help.projectSettings.worktree.title": "Worktree configuration",
	"help.projectSettings.worktree.body":
		"How task worktrees are built from this repo — sparse-checkout paths and which extra files are copied in — so each agent gets exactly the working tree it needs.",
	"help.projectSettings.automations.title": "Automations",
	"help.projectSettings.automations.body":
		"Scheduled agent runs for this project. Create, enable, run now, or inspect the run history of each automation; every fire lands as an ordinary task on the board.",

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
	"help.modal.addProject.title": "Add a project",
	"help.modal.addProject.body":
		"Point dev3 at a local git repo, clone a remote first, or create an Operations board — a virtual project whose tasks run agents in managed folders, without git.",
	"help.modal.spawnAgent.title": "Spawn an agent",
	"help.modal.spawnAgent.body":
		"Drop a second agent into this task's existing session — same worktree, same terminal. Useful to hand off to a different model or run a helper alongside the main agent.",
	"help.modal.taskDetail.title": "Task details",
	"help.modal.taskDetail.body":
		"Edit everything about the task: title, description (the agent's prompt), labels, priority, and status. Changes apply across the whole variant group.",
	"help.modal.automation.title": "Automation",
	"help.modal.automation.body":
		"A schedule that fires an agent on a recurring cadence. Pick the cadence, timezone, prompt, and agent — each run creates an ordinary task on the board.",
	"help.modal.scheduleMessage.title": "Send later",
	"help.modal.scheduleMessage.body":
		"Queue a one-shot prompt to reach the live agent (or a chosen tmux pane) at a later time — a nudge, a follow-up, or a reminder without babysitting the session.",
	"help.modal.bugHunters.title": "Bug hunters",
	"help.modal.bugHunters.body":
		"Unleash a swarm of parallel agents on this task's code, each hunting bugs from a different angle in its own worktree. Choose how many and which agent; findings come back for you to triage.",

	// ── Viewers & workspace ──
	"help.viewer.images.title": "Shared images",
	"help.viewer.images.body":
		"Screenshots and renders an agent surfaced with `dev3 show-image`, newest first. Step through the history, copy an image, or reveal the original file on disk.",
	"help.viewer.artifact.title": "Artifact",
	"help.viewer.artifact.body":
		"An interactive HTML report an agent built with `dev3 show-artifact`, sandboxed beside the terminal. Resize it, go fullscreen, step through past artifacts, or download it as HTML (or a ZIP when it bundles images).",

	// ── Terminal ──
	"help.terminal.quickShell.title": "Project shell",
	"help.terminal.quickShell.body":
		"A project-level terminal with no git worktree — for quick commands that aren't a task. Nothing here is tracked on the board or tied to a branch, unlike a task terminal.",

	// ── Header / sidebar ──
	"help.header.utilities.title": "App utilities",
	"help.header.utilities.body":
		"App-wide tools: the coffee cup keeps your machine awake while agents run, the terminal icon manages tmux sessions, and the commit badge pulls fresh commits from the main branch.",
	"help.header.rateLimits.title": "Agent rate limits",
	"help.header.rateLimits.body":
		"Live account-wide usage of your agent's rate limit. The percent turns yellow at 80% and red at 95%, so you see a limit coming before it stalls your agents. Toggle it in Settings → Agents.",
	"help.header.tmuxSessions.title": "tmux sessions",
	"help.header.tmuxSessions.body":
		"Every tmux session dev3 is running across all tasks. Copy an attach command to open one in your own terminal, or kill a stale session to free it up.",
	"help.sidebar.activeTasks.title": "Active tasks",
	"help.sidebar.activeTasks.body":
		"Every task with a live agent, across all projects. Click to jump to it; hover for a live terminal preview.",

	// ── Form fields ──
	"help.field.taskBranch.title": "Why this branch?",
	"help.field.taskBranch.body":
		"New tasks start from the project's currently checked-out branch when it isn't the base branch — so small tasks stack onto a big feature you're building. Clear the field to fall back to the project's default base branch.",
	"help.field.streamerMode.title": "Hide private info on stream",
	"help.field.streamerMode.body":
		"When on, identity-bearing values — account emails and names, organizations, home-folder paths, tunnel URLs, and the remote-access QR code — are blurred across the UI. Terminal content is NOT masked: panes print whatever agents output. Toggle it quickly from the ⇧⌘P command palette.",
} as const;

export default help;
