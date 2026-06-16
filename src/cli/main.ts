import { parseArgs, resolveFileArgs } from "./args";
import { detectContext, resolveSocketPath } from "./context";
import { exitAppNotRunning, exitInternalError, exitUsage } from "./output";
import { handleProjects } from "./commands/projects";
import { handleTasks } from "./commands/tasks";
import { handleTask } from "./commands/task";
import { handleCurrent } from "./commands/current";
import { handleNote } from "./commands/note";
import { handleVents } from "./commands/vents";
import { handleOverview } from "./commands/overview";
import { handleLabel } from "./commands/label";
import { handleInstallHooks } from "./commands/install-hooks";
import { handleInstallSkills } from "./commands/install-skills";
import { handleConfig } from "./commands/config";
import { handleDevServer } from "./commands/dev-server";
import { handleRemote } from "./commands/remote";
import { handleGui } from "./commands/gui";
import { handleConversations } from "./commands/conversations";
import { BUILD_TIME, BUILD_COMMIT, BUILD_VERSION } from "../shared/build-info.generated";
import { CLI_EXIT_CODE_SUCCESS } from "../shared/cli-exit-codes";

const HELP = `dev3 — AI-facing CLI for the dev-3.0 Kanban board.
Auto-detects project and task from the worktree context.

Commands:
  dev3 current [--brief]                Show current project, task, status
                                         (--brief: hide the full description if you already have it in your prompt)
  dev3 task show [--task <id>]          Full task details
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
  dev3 conversations search "<query>" [--limit N] [--all-statuses] [--json]  Search past task conversations (completed/cancelled)
  dev3 dev-server start [task-id]       Start a task dev server
  dev3 dev-server stop [task-id]        Stop a task dev server
  dev3 dev-server restart [task-id]     Restart a task dev server
  dev3 dev-server status [task-id]      Show task dev server status
  dev3 config show                       Show effective project settings (merged)
  dev3 config export                     Export settings to .dev3/config.json
  dev3 install-hooks                     Install agent hooks in current worktree
  dev3 install-skills                    Install agent skills globally
  dev3 projects list                    List all projects
  dev3 remote [--tunnel]                 Run headless — serve the UI to a browser
                                         (see "dev3 remote --help" for full usage)
  dev3 gui                               Launch the dev-3.0 desktop app
                                         (Linux: lazily downloads bundle on first run.
                                          See "dev3 gui --help" for full usage)

Statuses: todo, in-progress, user-questions, review-by-ai, review-by-user
  ("completed" and "cancelled" are UI-only — they destroy the worktree)

@file syntax: any argument starting with @ reads from file (e.g. @plan.md).
  Double @@ for literal @.

Options: --project <id> (override auto-detect), --task <id> / --task-id <id> (override task target), --help, --version
`;


async function main(): Promise<void> {
	const rawArgs = process.argv.slice(2);

	// Subcommands that own their own --help output. Route to them before
	// we swallow --help as the generic top-level help.
	const ownsHelp = new Set(["remote", "gui"]);
	const firstPositional = rawArgs.find((a) => !a.startsWith("-"));
	const routeToSubcommand = firstPositional && ownsHelp.has(firstPositional);

	if (rawArgs.length === 0 || ((rawArgs.includes("--help") || rawArgs.includes("-h")) && !routeToSubcommand)) {
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
	const socketPath = resolveSocketPath();

	// Commands that work without the app running
	if (command === "current") {
		return await handleCurrent(socketPath, { brief: Boolean(args.flags.brief) });
	}
	if (command === "install-hooks") {
		return await handleInstallHooks();
	}
	if (command === "install-skills") {
		return await handleInstallSkills();
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

	// All other commands require the socket
	if (!socketPath) {
		exitAppNotRunning();
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
			case "config":
				return await handleConfig(subcommand, args, socketPath, context);
			case "dev-server":
				return await handleDevServer(subcommand, args, socketPath, context);
			default:
				exitUsage(`Unknown command: ${command}\nRun "dev3 --help" for usage.`);
		}
	} catch (err) {
		if (err instanceof Error && err.message === "APP_NOT_RUNNING") {
			exitAppNotRunning();
		}
		throw err;
	}
}

main().catch((err) => {
	exitInternalError(err instanceof Error ? err.message : String(err));
});
