// Declarative help registry — the single source of truth for per-command and
// per-subcommand `--help` output. main.ts routes `dev3 <cmd> [<sub>] --help`
// here so every command-with-subcommands prints its own focused usage instead
// of falling back to the generic top-level help.
//
// `remote` and `gui` intentionally render their own richer, hand-written help
// inside their handlers and are NOT listed here (see `ownsHelp` in main.ts).

/** One subcommand of a command group (e.g. `task create`). */
export interface SubcommandHelp {
	/** Subcommand keyword, e.g. "create". */
	name: string;
	/** Full usage line, e.g. `dev3 task create --title "..." [--description "..."]`. */
	usage: string;
	/** One-line summary shown in the group listing and the detail header. */
	summary: string;
	/** Extra lines (flag descriptions, notes, examples) for the detail view. */
	details?: string[];
}

/** A top-level command. Leaf commands (no subcommands) use `usage`/`details`. */
export interface CommandHelp {
	/** Command keyword, e.g. "task". */
	name: string;
	/** One-line summary of the command group. */
	summary: string;
	/** Subcommands; empty for leaf commands like `vents` or `current`. */
	subcommands: SubcommandHelp[];
	/** Usage line for a leaf command (only when `subcommands` is empty). */
	usage?: string;
	/** Detail lines for a leaf command. */
	details?: string[];
}

const GLOBAL_OPTIONS = [
	"--project <id>            Override project auto-detection",
	"--task <id> / --task-id   Override the target task (else auto-detected from the worktree)",
	"-h, --help                Show help",
	"-v, --version             Show CLI version",
];

const COMMANDS: CommandHelp[] = [
	{
		name: "current",
		summary: "Show the current project, task, status, and overview.",
		subcommands: [],
		usage: "dev3 current [--brief]",
		details: [
			"--brief    Hide the full task description (use when you already have it in your prompt).",
		],
	},
	{
		name: "task",
		summary: "Inspect and manage individual tasks.",
		subcommands: [
			{
				name: "show",
				usage: "dev3 task show [<id>] [--task <id>] [--notes] [--history]",
				summary: "Show full task details (always includes the current overview).",
				details: [
					"--notes      Inline the task's note bodies.",
					"--history    Show the title/overview change log.",
					"Without an id, targets the current worktree's task.",
				],
			},
			{
				name: "create",
				usage: 'dev3 task create --title "..." [--description "..."]',
				summary: "Create a new task in the To Do column.",
				details: [
					"--title <text>        Task title (required).",
					"--description <text>  Longer description (optional).",
					"Positional content (or @file) becomes the description; its first line",
					"is used as the title when --title is omitted.",
				],
			},
			{
				name: "update",
				usage: 'dev3 task update [<id>] --title "..." [--description "..."]',
				summary: "Update a task's title and/or description.",
				details: [
					"--title <text>        New title (cannot be empty).",
					'--description <text>  New description ("" clears it).',
					"--force               Overwrite a user-edited title (diagnostics only — avoid).",
				],
			},
			{
				name: "move",
				usage: "dev3 task move [<id>] --status <status>",
				summary: "Change a task's status / column.",
				details: [
					"--status <status>        Target status or custom column id (required).",
					"--if-status <status>     Only move if the current status matches.",
					"--if-status-not <s>      Only move if the current status differs.",
					"Built-in: todo, in-progress, user-questions, review-by-ai, review-by-user.",
					'"completed" asks the user for approval; "cancelled" is forbidden via CLI.',
				],
			},
		],
	},
	{
		name: "tasks",
		summary: "List tasks on the board.",
		subcommands: [
			{
				name: "list",
				usage: "dev3 tasks list [--status <s>] [--label <id>] [--limit <n>] [--offset <n>]",
				summary: "List tasks newest-first (default 50 per page).",
				details: [
					"--status <s>   Filter by status.",
					"--label <id>   Filter by label id (8-char prefix works).",
					"--limit <n>    Page size (default 50).",
					"--offset <n>   Skip n tasks, for paging.",
				],
			},
		],
	},
	{
		name: "note",
		summary: "Per-task scratchpad notes — durable, surfaced to future agents.",
		subcommands: [
			{
				name: "add",
				usage: 'dev3 note add "..." [--task <id>] [--source user|ai]',
				summary: "Add a note to a task.",
				details: ["--source user|ai   Note author (default ai)."],
			},
			{
				name: "list",
				usage: "dev3 note list [--task <id>]",
				summary: "List a task's notes (one line each).",
			},
			{
				name: "show",
				usage: "dev3 note show <id> [--task <id>]",
				summary: "Show one note's full body (8-char prefix works).",
			},
			{
				name: "delete",
				usage: "dev3 note delete <id> [--task <id>]",
				summary: "Delete a note (8-char prefix works).",
			},
		],
	},
	{
		name: "overview",
		summary: "The task overview — a 1-2 sentence sticky-note summary.",
		subcommands: [
			{
				name: "set",
				usage: 'dev3 overview set "..." [--task <id>]',
				summary: "Set the task overview (max 500 chars, one paragraph).",
			},
			{
				name: "show",
				usage: "dev3 overview show [--task <id>]",
				summary: "Show the overview (falls back to the description).",
			},
			{
				name: "clear",
				usage: "dev3 overview clear [--task <id>]",
				summary: "Remove the task overview.",
			},
		],
	},
	{
		name: "label",
		summary: "Manage project labels and task label assignments.",
		subcommands: [
			{
				name: "list",
				usage: "dev3 label list",
				summary: "List the project's labels.",
			},
			{
				name: "create",
				usage: 'dev3 label create "name" [--color "#hex"]',
				summary: "Create a label.",
			},
			{
				name: "delete",
				usage: "dev3 label delete <id>",
				summary: "Delete a label.",
			},
			{
				name: "set",
				usage: "dev3 label set <id> [<id>...] [--task <id>]",
				summary: "Assign labels to a task.",
				details: ["--clear    Remove all labels from the task (dev3 label set --clear)."],
			},
		],
	},
	{
		name: "conversations",
		summary: "Search past task conversations (transcripts + notes/overview).",
		subcommands: [
			{
				name: "search",
				usage: 'dev3 conversations search "<query>" [--limit N] [--all-statuses] [--json]',
				summary: "Search completed/cancelled task conversations for relevant prior work.",
				details: [
					"--limit N        Max results (default 5).",
					"--all-statuses   Include active tasks too.",
					"--json           Machine-readable output.",
				],
			},
		],
	},
	{
		name: "dev-server",
		summary: "Control a task's dev server (runs in a tmux window).",
		subcommands: [
			{
				name: "start",
				usage: "dev3 dev-server start [task-id] [--wait] [--timeout <sec>]",
				summary: "Start a task's dev server. --wait blocks until it is listening on a port (default timeout 120s).",
			},
			{
				name: "stop",
				usage: "dev3 dev-server stop [task-id]",
				summary: "Stop a task's dev server (verified: waits until its processes are dead and ports released).",
			},
			{
				name: "restart",
				usage: "dev3 dev-server restart [task-id] [--wait] [--timeout <sec>]",
				summary: "Restart a task's dev server. --wait blocks until the NEW server is listening on a port.",
			},
			{
				name: "status",
				usage: "dev3 dev-server status [task-id]",
				summary: "Show a task's dev server status, including dev-owned ports and port conflicts (default subcommand).",
			},
		],
	},
	{
		name: "config",
		summary: "Inspect and export effective project settings.",
		subcommands: [
			{
				name: "show",
				usage: "dev3 config show",
				summary: "Show effective (merged) project settings (default subcommand).",
			},
			{
				name: "export",
				usage: "dev3 config export",
				summary: "Export settings to .dev3/config.json.",
			},
		],
	},
	{
		name: "projects",
		summary: "Inspect configured projects.",
		subcommands: [
			{
				name: "list",
				usage: "dev3 projects list",
				summary: "List all configured projects (default subcommand).",
			},
		],
	},
	{
		name: "vents",
		summary: "File anonymous dev3-platform feedback. No PII, no project specifics.",
		subcommands: [],
		usage: 'dev3 vents "short name" "markdown body"',
		details: [
			"Writes one local markdown file for the dev3 maintainer.",
			"Describe ONLY dev3 the tool — never include code, paths, or task content.",
		],
	},
	{
		name: "notify",
		summary: "Surface an in-app toast (or native OS notification) in the running app.",
		subcommands: [],
		usage: 'dev3 notify "message" [--level info|success|error] [--desktop]',
		details: [
			"--level <l>   Toast style: info (default), success, or error.",
			"--desktop     Fire a native OS notification instead of an in-app toast (requires a task).",
			"When a task is in context the toast/notification is clickable and opens that task.",
			"Targets the current worktree's task; override with --task <id>.",
		],
	},
	{
		name: "attention",
		summary: "Light the red attention badge on a task card, with an optional reason.",
		subcommands: [],
		usage: 'dev3 attention "reason" [--task <id>]',
		details: [
			"Same visual surface as the terminal bell; the reason shows on hover.",
			"The badge clears when the user opens the task.",
			"Targets the current worktree's task; override with --task <id>.",
		],
	},
	{
		name: "ui",
		summary: "Inspect the app's current UI state.",
		subcommands: [
			{
				name: "state",
				usage: "dev3 ui state [--json]",
				summary: "Show the focused task/project, foreground, user idle time, and the worktree's tmux layout.",
				details: [
					"Reports how long the user has been idle (userActivity) so you can pick the right channel.",
					"Includes an ASCII map of the active tmux window's panes plus a pane/window list.",
					"--json    Emit the raw state object (for machine consumption).",
					"Lets an agent decide whether a ping is needed (e.g. skip if the user is already on this task).",
				],
			},
		],
	},
	{
		name: "install-hooks",
		summary: "Install agent status-sync hooks in the current worktree.",
		subcommands: [],
		usage: "dev3 install-hooks",
		details: ["Writes Claude Code and Codex hook configs into the worktree."],
	},
	{
		name: "install-skills",
		summary: "Install / refresh the dev3 agent skills globally.",
		subcommands: [],
		usage: "dev3 install-skills",
		details: ["Writes the dev3 skill files into ~/.claude, ~/.codex, ~/.cursor, etc."],
	},
];

const COMMAND_INDEX: Map<string, CommandHelp> = new Map(COMMANDS.map((c) => [c.name, c]));

/** Whether the registry knows how to render help for this command. */
export function hasCommandHelp(command: string): boolean {
	return COMMAND_INDEX.has(command);
}

/** Look up a command's help spec (mainly for tests). */
export function getCommandHelp(command: string): CommandHelp | undefined {
	return COMMAND_INDEX.get(command);
}

function indentLines(lines: string[], pad = "  "): string {
	return lines.map((l) => `${pad}${l}`).join("\n");
}

function renderGlobalOptions(): string {
	return `\nGlobal options:\n${indentLines(GLOBAL_OPTIONS)}\n`;
}

/** Render the detail view for a single subcommand or a leaf command. */
function renderLeaf(title: string, usage: string, summary: string, details?: string[]): string {
	let out = `${title} — ${summary}\n\nUsage:\n  ${usage}\n`;
	if (details && details.length > 0) {
		out += `\nDetails:\n${indentLines(details)}\n`;
	}
	out += renderGlobalOptions();
	return out;
}

/** Render the listing view for a command group (all its subcommands). */
function renderGroup(cmd: CommandHelp): string {
	const usageWidth = Math.max(...cmd.subcommands.map((s) => s.usage.length));
	const rows = cmd.subcommands
		.map((s) => `  ${s.usage.padEnd(usageWidth)}   ${s.summary}`)
		.join("\n");
	let out = `dev3 ${cmd.name} — ${cmd.summary}\n\nSubcommands:\n${rows}\n`;
	out += `\nRun "dev3 ${cmd.name} <subcommand> --help" for details on a subcommand.\n`;
	out += renderGlobalOptions();
	return out;
}

/**
 * Render help for `dev3 <command> [<subcommand>] --help`.
 * Returns the formatted help text, or null if the command is unknown.
 *
 * - Leaf command (no subcommands): renders its own usage/details.
 * - Group + known subcommand: renders that subcommand's detail view.
 * - Group + unknown/no subcommand: renders the group listing.
 */
export function renderHelp(command: string, subcommand?: string): string | null {
	const cmd = COMMAND_INDEX.get(command);
	if (!cmd) return null;

	// Leaf command — no subcommands to list.
	if (cmd.subcommands.length === 0) {
		return renderLeaf(`dev3 ${cmd.name}`, cmd.usage ?? `dev3 ${cmd.name}`, cmd.summary, cmd.details);
	}

	if (subcommand) {
		const sub = cmd.subcommands.find((s) => s.name === subcommand);
		if (sub) {
			return renderLeaf(`dev3 ${cmd.name} ${sub.name}`, sub.usage, sub.summary, sub.details);
		}
		// Unknown subcommand — fall through to the group listing (more helpful
		// than an error, and surfaces the valid subcommands).
	}

	return renderGroup(cmd);
}

/** Commands that render their own (richer) --help inside their handlers. */
const OWNS_HELP = new Set(["remote", "gui"]);

/**
 * What `main()` should do about `--help` for a given argv (minus the leading
 * "dev3"). Pure so the routing decision is unit-testable without process.exit:
 *
 * - `command` → print `text` (command/subcommand-specific help) and exit.
 * - `top`     → print the generic top-level help and exit.
 * - `none`    → not a help request we handle here; continue normal routing
 *               (also covers `remote`/`gui --help`, which own their help).
 */
export type HelpResolution =
	| { action: "command"; text: string }
	| { action: "top" }
	| { action: "none" };

export function resolveHelp(rawArgs: string[]): HelpResolution {
	const wantsHelp = rawArgs.includes("--help") || rawArgs.includes("-h");
	const positionals = rawArgs.filter((a) => !a.startsWith("-"));
	const command = positionals[0];
	const subcommand = positionals[1];

	// `dev3 <command> [<subcommand>] --help` → command/subcommand-specific help.
	if (wantsHelp && command && !OWNS_HELP.has(command) && hasCommandHelp(command)) {
		const text = renderHelp(command, subcommand);
		if (text) return { action: "command", text };
	}

	// remote/gui own their --help; let those fall through to their handlers.
	const routeToOwnHelp = wantsHelp && Boolean(command) && OWNS_HELP.has(command);
	if (rawArgs.length === 0 || (wantsHelp && !routeToOwnHelp)) {
		return { action: "top" };
	}

	return { action: "none" };
}
