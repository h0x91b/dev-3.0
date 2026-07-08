import { parseArgs, resolveFileArgs } from "./args";
import { detectContext, resolveSocketPath, resolveSocketPathWithRetry, socketDiagnostics } from "./context";
import { exitAppNotRunning, exitInternalError, exitUsage } from "./output";
import { handleProjects } from "./commands/projects";
import { handleTasks } from "./commands/tasks";
import { handleTask } from "./commands/task";
import { handleCurrent } from "./commands/current";
import { handleNote } from "./commands/note";
import { handleVents } from "./commands/vents";
import { handleOverview } from "./commands/overview";
import { handleLabel } from "./commands/label";
import { handleAutomations } from "./commands/automations";
import { handleInstallHooks } from "./commands/install-hooks";
import { handleInstallSkills } from "./commands/install-skills";
import { handleConfig } from "./commands/config";
import { handleDevServer } from "./commands/dev-server";
import { handleRemote } from "./commands/remote";
import { handleGui } from "./commands/gui";
import { handleConversations } from "./commands/conversations";
import { handleNotify, handleAttention, handleUi } from "./commands/ui-control";
import { handleShowImage } from "./commands/show-image";
import { handleStatusLine } from "./commands/statusline";
import { handleCodexHook } from "./commands/codex-hook";
import { handleDoctor } from "./commands/doctor";
import { BUILD_TIME, BUILD_COMMIT, BUILD_VERSION } from "../shared/build-info.generated";
import { CLI_EXIT_CODE_SUCCESS } from "../shared/cli-exit-codes";
import { installEpipeGuard, isEpipeError } from "./epipe";
import { resolveHelp } from "./help";

const HELP = `dev3 — AI-facing CLI for the dev-3.0 Kanban board.
Auto-detects project and task from the worktree context.

Commands:
  dev3 current [--brief]                Show current project, task, status
                                         (--brief: hide the full description if you already have it in your prompt)
  dev3 task show [--task <id>] [--notes] [--history]  Full task details
                                         (always shows current overview; --notes inlines note bodies, --history shows title/overview change log)
  dev3 task move [--task <id>] --status <status>  Change task status
  dev3 task update [--task <id>] --title "..." [--description "..."]  Update title/description
  dev3 task create --title "..." [--description "..."]  Create a new task (To Do)
  dev3 note add "..." [--task <id>] [--source user]  Add note to a task
  dev3 note list [--task <id>]          List notes
  dev3 note show <id> [--task <task>]   Show one note's full body (8-char prefix works)
  dev3 note delete <id> [--task <task>] Delete note (8-char prefix works)
  dev3 vents "name" "markdown"          File anonymous dev3-platform feedback (opt-in)
  dev3 overview set "..." [--task <id>] Set task overview (one paragraph)
  dev3 overview show [--task <id>]      Show task overview (or description fallback)
  dev3 overview clear [--task <id>]     Remove task overview
  dev3 label list                       List project labels
  dev3 label create "name" [--color "#hex"]  Create label
  dev3 label delete <id>                Delete label
  dev3 label set <id> [<id>...] [--task <task>]  Assign labels to a task
  dev3 label set --clear [--task <id>]  Remove all labels from a task
  dev3 tasks list [--status <s>] [--label <id>] [--limit <n>] [--offset <n>]  List tasks (newest first, default 50)
  dev3 automations list                 List project automations (scheduled agent runs)
  dev3 automations show <id>            Automation details + run history
  dev3 automations create --name "..." --prompt "..." --rrule "FREQ=DAILY;BYHOUR=9" [--template shipped-report]
  dev3 automations update <id> [--enable|--disable] [--rrule ...] [--prompt ...]
  dev3 automations delete <id>          Delete an automation
  dev3 automations run <id>             Fire an automation now (creates its task)
  dev3 automations templates            List built-in templates
  dev3 conversations search "<query>" [--limit N] [--all-statuses] [--json]  Search past task conversations (completed/cancelled)
  dev3 dev-server start [task-id]       Start a task dev server
  dev3 dev-server stop [task-id]        Stop a task dev server
  dev3 dev-server restart [task-id]     Restart a task dev server
  dev3 dev-server status [task-id]      Show task dev server status
  dev3 notify "msg" [--level info|success|error] [--desktop]  Show an in-app toast (or OS notification); clicking opens the task
  dev3 attention "reason" [--task <id>] Light the red attention badge on the task card (reason shows on hover)
  dev3 show-image <path> [--caption "..."] [<path> ...]  Show images (screenshots/renders) in an in-app viewer bound to the task; each --caption annotates the preceding image
  dev3 ui state [--json]                 Show focused task/project, foreground, user idle time + the worktree's tmux layout (ASCII pane map)
  dev3 config show                       Show effective project settings (merged)
  dev3 config export                     Export settings to .dev3/config.json
  dev3 doctor [--json]                   Check install health (app bundle, tmux shim, brew state); works without the app running
  dev3 install-hooks                     Install Claude worktree hooks and stable Codex user hooks
  dev3 install-skills                    Install agent skills globally
  dev3 projects list                    List all projects
  dev3 remote [start|status|url|stop]    Run headless — serve the UI to a browser
                                         (backgrounds by default; manage it with
                                          status / url / restart / logs / stop.
                                          See "dev3 remote --help" for full usage)
  dev3 gui                               Launch the dev-3.0 desktop app
                                         (Linux: lazily downloads bundle on first run.
                                          See "dev3 gui --help" for full usage)

Statuses: todo, in-progress, user-questions, review-by-ai, review-by-user
  ("completed" and "cancelled" are UI-only — they destroy the worktree)

@file syntax: any argument starting with @ reads from file (e.g. @plan.md).
  Double @@ for literal @.

Options: --project <id> (override auto-detect), --task <id> / --task-id <id> (override task target), --help, --version

Run "dev3 <command> --help" (e.g. "dev3 task --help") for command-specific usage,
or "dev3 <command> <subcommand> --help" (e.g. "dev3 task create --help") for a single subcommand.
`;


async function main(): Promise<void> {
	const rawArgs = process.argv.slice(2);

	// Every short print-and-exit command may have its stdout closed early by a
	// downstream consumer (`dev3 … | head`, `| grep -m1`, quitting a pager).
	// Install the broken-pipe guard so that turns into a clean exit instead of a
	// raw Bun EPIPE stack trace. `remote`/`gui` are long-running and install
	// their own crash handlers, so we leave them untouched.
	if (rawArgs[0] !== "remote" && rawArgs[0] !== "gui") {
		installEpipeGuard();
	}

	// `--help` routing (pure decision in help.ts so it stays unit-testable):
	// a known command/subcommand gets focused help from the declarative registry,
	// `remote`/`gui --help` fall through to their own handlers, and everything
	// else (incl. no args) prints the generic top-level help.
	const help = resolveHelp(rawArgs);
	if (help.action === "command") {
		process.stdout.write(help.text);
		process.exit(CLI_EXIT_CODE_SUCCESS);
	}
	if (help.action === "top") {
		process.stdout.write(HELP);
		process.exit(CLI_EXIT_CODE_SUCCESS);
	}

	if (rawArgs.includes("--version") || rawArgs.includes("-v")) {
		process.stdout.write(`dev3 v${BUILD_VERSION} (${BUILD_COMMIT}) ${BUILD_TIME}\n`);
		process.exit(CLI_EXIT_CODE_SUCCESS);
	}

	const command = rawArgs[0];
	const subcommand = rawArgs[1] && !rawArgs[1].startsWith("--") ? rawArgs[1] : undefined;
	const restArgs = subcommand ? rawArgs.slice(2) : rawArgs.slice(1);
	const args = resolveFileArgs(parseArgs(restArgs));

	const context = detectContext();
	let socketPath = resolveSocketPath();

	// Commands that work without the app running
	if (command === "current") {
		return await handleCurrent(socketPath, { brief: Boolean(args.flags.brief) });
	}
	if (command === "install-hooks") {
		return await handleInstallHooks();
	}
	if (command === "statusline") {
		// Internal: Claude Code statusLine wrapper (see commands/statusline.ts).
		// Reads stdin, dumps rate limits, delegates to the user's original
		// statusLine. Must work without the app running.
		return await handleStatusLine();
	}
	if (command === "hook" && subcommand === "codex") {
		// Internal lifecycle adapter. It intentionally remains successful when
		// the app is offline so a status-sync failure can never block Codex.
		return await handleCodexHook(
			await Bun.stdin.text(),
			socketPath || context?.socketPath || null,
			context,
		);
	}
	if (command === "install-skills") {
		return await handleInstallSkills();
	}
	if (command === "doctor") {
		// Install health check — must work precisely when the app is broken
		// or not running, so it never touches the socket.
		return await handleDoctor(args);
	}
	if (command === "conversations") {
		// Read-only search over local transcript files — no app/socket needed.
		return await handleConversations(subcommand, args, context);
	}
	if (command === "remote") {
		// `dev3 remote` IS the app in headless mode — it must not require a
		// running instance socket. It starts its own CLI socket once up.
		return await handleRemote(subcommand, args);
	}
	if (command === "gui") {
		// `dev3 gui` launches the desktop app (mac) or the bundled launcher
		// (Linux). It does not need the headless server, and on Linux it
		// lazily installs the GUI bundle on first run.
		return await handleGui(subcommand, args);
	}

	// All other commands require the socket. A single discovery probe can miss
	// transiently (filesystem hiccup, app momentarily recreating its socket),
	// so retry briefly before declaring the app offline (see issue #714).
	if (!socketPath) {
		socketPath = await resolveSocketPathWithRetry();
	}
	if (!socketPath) {
		exitAppNotRunning({ stage: "discovery", ...debugAppNotRunning("discovery") });
	}

	try {
		switch (command) {
			case "projects":
				return await handleProjects(subcommand, args, socketPath);
			case "tasks":
				return await handleTasks(subcommand, args, socketPath, context);
			case "task":
				return await handleTask(subcommand, args, socketPath, context);
			case "note":
				return await handleNote(subcommand, args, socketPath, context);
			case "vents":
				// `vents` takes no subcommand — its first positional is the vent
				// name, so re-parse from the raw args without the subcommand split.
				return await handleVents(resolveFileArgs(parseArgs(rawArgs.slice(1))), socketPath);
			case "overview":
				return await handleOverview(subcommand, args, socketPath, context);
			case "label":
				return await handleLabel(subcommand, args, socketPath, context);
			case "automations":
				return await handleAutomations(subcommand, args, socketPath, context);
			case "config":
				return await handleConfig(subcommand, args, socketPath, context);
			case "dev-server":
				return await handleDevServer(subcommand, args, socketPath, context);
			case "notify":
				// `notify` takes no subcommand — its first positional is the message,
				// so re-parse from the raw args without the subcommand split.
				return await handleNotify(resolveFileArgs(parseArgs(rawArgs.slice(1))), socketPath, context);
			case "attention":
				// Same shape as `notify`: first positional is the reason.
				return await handleAttention(resolveFileArgs(parseArgs(rawArgs.slice(1))), socketPath, context);
			case "show-image":
				// Parsing is order-aware (a `--caption` binds to the preceding image
				// path), so hand the raw tokens straight to the handler rather than
				// through the order-losing `parseArgs`.
				return await handleShowImage(rawArgs.slice(1), socketPath, context);
			case "ui":
				return await handleUi(subcommand, args, socketPath, context);
			default:
				exitUsage(`Unknown command: ${command}\nRun "dev3 --help" for usage.`);
		}
	} catch (err) {
		if (err instanceof Error && err.message === "APP_NOT_RUNNING") {
			const connectCode = (err as Error & { connectCode?: string }).connectCode;
			exitAppNotRunning({ stage: "connect", socketPath, ...debugAppNotRunning("connect", connectCode) });
		}
		throw err;
	}
}

/**
 * Build the diagnostics payload for exitAppNotRunning. Returns the stage + full
 * socket diagnostics only when DEV3_DEBUG is set, so normal output stays terse
 * while bug reporters can rerun with DEV3_DEBUG=1 to capture the actual cause.
 */
function debugAppNotRunning(
	stage: "discovery" | "connect",
	connectCode?: string,
): { diagnostics?: string } {
	if (process.env.DEV3_DEBUG !== "1" && process.env.DEV3_DEBUG !== "true") return {};
	// The human-readable stage line is added by exitAppNotRunning; here we only
	// attach the raw socket diagnostics + last connect errno.
	void stage;
	const parts = [socketDiagnostics()];
	if (connectCode) parts.push(`  last connect errno: ${connectCode}`);
	return { diagnostics: parts.join("\n") };
}

main().catch((err) => {
	// A broken pipe that surfaced as a promise rejection (rather than the
	// uncaughtException the guard already handles) is still a clean stop.
	if (isEpipeError(err)) process.exit(CLI_EXIT_CODE_SUCCESS);
	exitInternalError(err instanceof Error ? err.message : String(err));
});
