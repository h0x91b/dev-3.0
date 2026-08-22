// Declarative help registry — the single source of truth for per-command and
// per-subcommand `--help` output. main.ts routes `dev3 <cmd> [<sub>] --help`
// here so every command-with-subcommands prints its own focused usage instead
// of falling back to the generic top-level help.
//
// `remote` and `gui` intentionally render their own richer, hand-written help
// inside their handlers and are NOT listed here (see `ownsHelp` in main.ts).

import { AGENT_MESSAGE_SPILL_THRESHOLD_BYTES, MAX_SCHEDULED_MESSAGE_LENGTH } from "../shared/types";

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
	"--task <id> / --task-id   Override the target task (else auto-detected from the worktree);",
	"                          accepts a full id, an id prefix (≥8 chars), or seq:<N> (the stable",
	"                          per-project number printed by `task create` and shown on cards)",
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
				usage: 'dev3 task create --title "..." [--description "..." | --description -] | dev3 task create --scratch --run',
				summary: "Create a task in To Do, or ask the user to start a scratch peer agent.",
				details: [
					"--title <text>        Task title (required).",
					"--description <text>  Longer description (optional); use - to read it from stdin.",
					"Positional content (or @file) becomes the description; its first line",
					"is used as the title when --title is omitted.",
					"--scratch --run       Ask the user to start a throwaway peer agent — no title,",
					"                      no prompt. Blocks up to 10 min on their approval in the",
					"                      app; exit 10 if declined. Drive it with `dev3 message`.",
				],
			},
			{
				name: "update",
				usage: 'dev3 task update [<id>] [--title "..."] [--description "..." | --description -] [--priority P0..P4] [--manual-completion on|off] [--type coordinator|pr-review|standard]',
				summary: "Update a task's title, description, priority, completion policy, or type.",
				details: [
					"--title <text>        New title (cannot be empty).",
					'--description <text>  New description ("" clears it); use - to read it from stdin.',
					"--priority <P0..P4>   Set importance (P0 highest … P4 lowest); applies to the whole variant group.",
					"                      Only set priority when the user asks — never on your own initiative.",
					"--manual-completion on|off  Control whether merge detection suggests completing this task.",
					"--type coordinator|pr-review|standard  Set the task's type, or clear it with standard.",
					"                      Rewrites the description's role preamble and tells a running agent,",
					"                      so the badge never claims a role the agent was not given.",
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
					"--tolerate-app-offline   Exit 0 (with a stderr warning) when the app is not",
					"                         running, instead of exit 2. For generated hooks.",
					"Built-in: todo, in-progress, user-questions, review-by-ai, review-by-user.",
					'"completed" asks the user for approval; "cancelled" is forbidden via CLI.',
					"Starting SOMEONE ELSE'S task (--task <other> + an active status) also asks",
					"the user, who picks the agent; exit 10 if they decline.",
				],
			},
			{
				name: "open",
				usage: "dev3 task open [<id>] [--task <id>]",
				summary: "Focus the app on a task (same navigation as a dev3://task/<id> link).",
				details: [
					"Without an id, targets the current worktree's task.",
					"Honors the split-vs-fullscreen task open-mode preference.",
					"Reopens a window when the app sits window-less in the dock.",
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
				summary: "List tasks: live work, then To Do, then completed, then cancelled (default 50 per page).",
				details: [
					"Newest first (highest seq) inside each group.",
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
				usage: 'dev3 note add "..." [--content "..."] [--task <id>] [--source user|ai]',
				summary: "Add a note to a task.",
				details: [
					"--content <text>  Alternative to positional content; use - to read it from stdin.",
					"--source user|ai   Note author (default ai).",
				],
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
		name: "automations",
		summary: "Scheduled agent runs: recurring prompts that create real tasks on the board.",
		subcommands: [
			{
				name: "list",
				usage: "dev3 automations list",
				summary: "List the project's automations with next/last run.",
			},
			{
				name: "show",
				usage: "dev3 automations show <id>",
				summary: "Automation details, prompt, and run history (created / failed / missed).",
			},
			{
				name: "create",
				usage: 'dev3 automations create --name "..." [--prompt "..." | --prompt -] --rrule "FREQ=DAILY;BYHOUR=9" [--timezone <iana>]',
				summary: "Create an automation.",
				details: [
					'--rrule        RFC 5545 subset: FREQ=HOURLY|DAILY|WEEKLY|MONTHLY, INTERVAL, BYDAY, BYMONTHDAY, BYHOUR, BYMINUTE.',
					"--timezone     IANA name (default: this machine's timezone).",
					"--agent <id>   Agent to launch (default: project default agent).",
					"--catch-up     skip | runOnce — what to do with runs missed while the app was offline (default skip).",
					"--template     Pre-fill from a built-in template (see: dev3 automations templates).",
					"--disabled     Create paused.",
					"--prompt <text>  Use @file for a file or - to read the prompt from stdin.",
				],
			},
			{
				name: "update",
				usage: "dev3 automations update <id> [--name ...] [--prompt ... | --prompt -] [--rrule ...] [--timezone ...] [--enable|--disable]",
				summary: "Update fields / pause / resume.",
				details: ["--prompt <text>  Use @file for a file or - to read the prompt from stdin."],
			},
			{
				name: "delete",
				usage: "dev3 automations delete <id>",
				summary: "Delete an automation (its already-created tasks stay).",
			},
			{
				name: "run",
				usage: "dev3 automations run <id>",
				summary: "Fire now — creates the task immediately (schedule unaffected).",
			},
			{
				name: "templates",
				usage: "dev3 automations templates",
				summary: "List built-in templates (e.g. shipped-report — the weekly 'What I shipped' digest).",
			},
		],
	},
	{
		name: "conversations",
		summary: "Search past task conversations, or parse this task's transcripts into JSON.",
		subcommands: [
			{
				name: "dump",
				usage: "dev3 conversations dump [--latest] [--verbatim] [--payload N] [--action N] [--compact] [--raw] [--stdout] [--out <dir>]",
				summary: "Parse this task's agent transcripts into dev3's conversation model and write JSON.",
				details: [
					"Writes to the task's own conversations/ folder, next to logs/ and diffs/.",
					"By default the dump is trimmed: duplicated fields dropped, session bookkeeping",
					"collapsed to counts, tool payloads truncated. The native transcript stays the",
					"source of truth, so nothing trimmed here is lost.",
					"--latest      Only the most recently written transcript.",
					"--payload N   Characters kept per tool output / file content (default 1000).",
					"--action N    Characters kept per shell command / file path (default 2000).",
					"--verbatim    No trimming at all — everything, full length.",
					"--compact     One-line JSON. Indented by default, since dumps get read by hand.",
					"--raw         Keep each native record alongside the parsed event (much larger).",
					"--stdout      Print the JSON instead of writing files.",
					"--out DIR     Write somewhere else.",
				],
			},
			{
				name: "handoff",
				usage: "dev3 conversations handoff [--for claude|codex|markdown] [--thinking] [--tool-output N] [--turns N] [--out FILE]",
				summary: "Retell this task's conversation as one message another agent can be handed.",
				details: [
					"Prints to stdout, so it pipes into `dev3 message`.",
					"--for TARGET      Framing: markdown to read, claude or codex to hand over (default markdown).",
					"--thinking        Include the previous agent's reasoning (off by default).",
					"--tool-output N   Characters of tool output kept per call (default 2048, 0 drops it).",
					"--turns N         Keep only the last N turns.",
					"--out FILE        Write to a file instead of stdout.",
				],
			},
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
				summary: "Start a task's dev server. --wait blocks until it is listening on an assigned DEV3_PORT* (default timeout 120s).",
			},
			{
				name: "stop",
				usage: "dev3 dev-server stop [task-id]",
				summary: "Stop a task's dev server (verified: waits until its processes are dead and ports released).",
			},
			{
				name: "restart",
				usage: "dev3 dev-server restart [task-id] [--wait] [--timeout <sec>]",
				summary: "Restart a task's dev server. --wait blocks until the NEW server is listening on an assigned DEV3_PORT*.",
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
		name: "doctor",
		summary: "Check install health; works without the app running.",
		subcommands: [],
		usage: "dev3 doctor [--processes] [--worktrees] [--json]",
		details: [
			"Read-only checks: data dir, app bundle + version, tmux shim, pinned",
			"tmux@3.6 keg, Homebrew cask/formula state. Prints the exact fix",
			"command for anything broken (e.g. after a failed `brew upgrade`).",
			"--processes  Which task owns each native terminal host and shell:",
			"             task seq, pane, role, pid/parent, executable, liveness.",
			"             Use it when a process viewer shows only the executable",
			"             name (macOS Activity Monitor, Windows image-name column).",
			"             An inventory, not a check — it always exits 0.",
			"--worktrees  Disk footprint of ~/.dev3.0/worktrees per project and how",
			"             much of it is reclaimable: orphaned directories with no",
			"             task record, worktrees whose teardown never finished, and",
			"             old diffs/logs of finished tasks. Report-only by default.",
			"  --prune-orphans       Delete orphaned directories and finish the",
			"                        abandoned teardowns.",
			"  --prune-older-than D  Delete diffs/logs of finished tasks older than",
			"                        D (30d, 2w, 6m, 1y).",
			"  --force-unmerged      Also delete entries whose dev3/task-* branch is",
			"                        NOT merged into the base branch; without it",
			"                        those are reported and skipped.",
			"--json       Machine-readable output.",
			"Exit codes: 0 healthy or warnings only, 7 when problems were found,",
			"12 when a prune skipped or failed part of what it selected.",
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
		usage: 'dev3 notify "message" [--level info|success|error] [--duration <seconds>] [--desktop]',
		details: [
			"--level <l>   Toast style: info (default), success, or error.",
			"--duration <seconds>  In-app toast lifetime from 2s to 30s; the s suffix is optional (default: 30s).",
			"--desktop     Fire a native OS notification instead of an in-app toast (requires a task).",
			"--duration cannot be combined with --desktop; native notification lifetime is controlled by the OS.",
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
		name: "message",
		summary: "Send text to the task's live agent now, or schedule it for later.",
		subcommands: [],
		usage: 'dev3 message "text" [--in <dur> | --at <hh:mm>] [--task <id>]',
		details: [
			"Bare form delivers the text into the live agent immediately (types it + Enter).",
			"--in <dur>    Schedule after a delay, e.g. 30m, 2h, 1h30m (Send later).",
			"--at <hh:mm>  Schedule at the next occurrence of a local time (today or tomorrow).",
			"Text can be a positional arg, --message, or @file. An agent may schedule its own wake-up.",
			"Targets the current worktree's task; override with --task <id>.",
			"Messaging ANOTHER task from a worktree wraps the text in a <dev3-ai-message> envelope",
			"carrying your seq + the reply command, so the receiving agent knows who wrote it.",
			`Hard limit ${MAX_SCHEDULED_MESSAGE_LENGTH} chars. Past ${AGENT_MESSAGE_SPILL_THRESHOLD_BYTES} bytes the body no longer fits a`,
			"terminal, so it is written to a file and the agent is sent that path in the same envelope.",
		],
	},
	{
		name: "show-artifact",
		summary: "Surface a task-bound HTML artifact in the running app.",
		subcommands: [],
		usage: 'dev3 show-artifact <file.html> [--assets <file...>] [--title "..."] [--task <id>]',
		details: [
			"--assets <paths...>   Copy local CSS, classic JS, and raster assets; all following paths belong to the artifact until the next flag.",
			"--title <text>        Viewer title (defaults to the HTML filename).",
			"Artifacts with local assets download as ZIP; standalone artifacts download as HTML.",
		],
	},
	{
		name: "artifact-template",
		summary: "Copy this task's dev3 artifact starter into ./dev3-artifact-report.",
		subcommands: [],
		usage: "dev3 artifact-template [--task <id|seq:N>]",
		details: [
			"Provisions the pristine starter, copies it into ./dev3-artifact-report, and prints that path.",
			"Re-running it restores the managed files over an existing copy.",
			"Use it when $DEV3_ARTIFACT_TEMPLATE_DIR is unset: that variable is baked into the session",
			"environment at launch, so an older session or a shell that never inherited it has no other way",
			"to reach the starter.",
		],
	},
	{
		name: "inline-html",
		summary: "Fold a multi-file HTML report into one self-contained file.",
		subcommands: [],
		usage: "dev3 inline-html <index.html|dir> -o <out.html> [--json] [--quiet]",
		details: [
			"Embeds local stylesheets, scripts, images, SVGs and fonts (including url() refs inside CSS)",
			"as data URIs; remote CDN references are left alone because they resolve from the browser.",
			"A directory argument is read as <dir>/index.html.",
			"-o <path>   Where to write the folded file. Build outside the repo (/tmp) so it cannot be staged.",
			"--json      Machine-readable report (what was inlined, left external, and flagged).",
			"--quiet     Write the file and print nothing.",
			"Refuses to write in two cases: exit 13 a referenced local file is missing, exit 14 a",
			"credential-shaped string is embedded. Home paths, emails and tunnel URLs are reported,",
			"not blocked — a public URL is public forever, so review them first.",
			"Needs no running app: it is a pure file transform.",
		],
	},
	{
		name: "peek",
		summary: "Read-only glance at a task's terminal — what it was doing and how fresh that is.",
		subcommands: [],
		usage: "dev3 peek [--task <id|seq:N>] [--pane <N|paneId>] [--lines <N>] [--json]",
		details: [
			"Prints a header, one line per pane (command, alive/dead, age of last output) and the tail of the focused pane.",
			"--task <id>      Any task in any project; defaults to the current worktree's task.",
			"--project <id>   Narrow the search when a seq: ref matches tasks on several boards.",
			"--pane <N|id>    Tail another pane: the number from the summary, or its raw pane id.",
			"--lines <N>      Tail budget, 1..1000 (default 120).",
			"--json           Emit the raw snapshot object.",
			"Never focuses, writes, resizes, or takes ownership — the peeked task cannot tell it happened.",
			"A task with no live terminal answers successfully with the reason (draft, hibernated, not running).",
			"On tmux, output ages are per WINDOW (tmux has no per-pane activity time); native reports them per pane.",
		],
	},
	{
		name: "pane",
		summary: "Run a command in a neighbouring pane of your own task terminal and read what it printed.",
		subcommands: [
			{
				name: "list",
				usage: "dev3 pane list [--task <id>] [--json]",
				summary: "Which terminal backend this task is on, which panes exist, which one is yours.",
				details: [
					"Read the backend from here rather than guessing it from the platform — the native",
					"backend is not Windows-only, and tmux is not guaranteed to exist.",
					"Also states whether a pane's SCREEN text can be read here at all (see `dev3 peek`).",
				],
			},
			{
				name: "run",
				usage: 'dev3 pane run "<command>" [--below] [--label <name>] [--task <id>]',
				summary: "Open a pane next to yours, run the command there, and mirror its output to a log.",
				details: [
					"Put flags AFTER the command so the command is not read as a flag value.",
					"--below          Split below instead of to the right.",
					"--label <name>   Short human label for the pane (letters, digits, space, . _ -).",
					"The command runs through the platform's own shell (sh -c on POSIX, Windows PowerShell",
					"on Windows) with the task's worktree as cwd and the task's lifecycle env.",
					"Non-interactive only: stdin is closed, so this is for builds, tests, servers and watchers.",
					"Prints the run id; read the output with `dev3 pane logs <run-id>`.",
				],
			},
			{
				name: "logs",
				usage: "dev3 pane logs <run-id> [--lines <N>] [--task <id>] [--json]",
				summary: "The run's outcome (still running / exit code) plus a bounded tail of its output.",
				details: [
					"--lines <N>   Tail budget, 1..2000 (default 200). A dev server writes forever, so a read",
					"              is always a tail; the header says whether it was truncated.",
					"The outcome line distinguishes still-running from finished-with-exit-code, so a hung",
					"build never reads as a failed one.",
				],
			},
			{
				name: "close",
				usage: "dev3 pane close <run-id> [--task <id>]",
				summary: "Close the pane a run is executing in, which kills the command.",
				details: ["The run's log stays readable with `dev3 pane logs` after the pane is gone."],
			},
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
		summary: "Install status-sync hooks for Claude Code and Codex.",
		subcommands: [],
		usage: "dev3 install-hooks",
		details: [
			"Writes Claude Code and Codex status hooks into the current worktree.",
			"Codex hook hashes are calculated automatically and scoped to each launched session.",
		],
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
