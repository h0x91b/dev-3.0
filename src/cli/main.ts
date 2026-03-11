import { parseArgs, resolveFileArgs } from "./args";
import { detectContext, resolveSocketPath } from "./context";
import { exitAppNotRunning, exitUsage } from "./output";
import { handleProjects } from "./commands/projects";
import { handleTasks } from "./commands/tasks";
import { handleTask } from "./commands/task";
import { handleCurrent } from "./commands/current";
import { handleNote } from "./commands/note";
import { handleLabel } from "./commands/label";
import { handleInstallHooks } from "./commands/install-hooks";
import { handleInstallSkills } from "./commands/install-skills";

const HELP = `dev3 — AI-facing CLI for the dev-3.0 Kanban board.
Auto-detects project and task from the worktree context.

Commands:
  dev3 current                          Show current project, task, status
  dev3 task show                        Full task details
  dev3 task move --status <status>      Change task status
  dev3 task update --title "..." [--description "..."]  Update title/description
  dev3 task create --title "..."        Create a new task (To Do)
  dev3 note add "..." [--source user]   Add note to current task
  dev3 note list                        List notes
  dev3 note delete <id>                 Delete note (8-char prefix works)
  dev3 label list                       List project labels
  dev3 label create "name" [--color "#hex"]  Create label
  dev3 label delete <id>                Delete label
  dev3 label set <id> [<id>...]         Assign labels to current task
  dev3 label set --clear                Remove all labels from task
  dev3 tasks list [--status <s>] [--label <id>]  List/filter tasks
  dev3 install-hooks                     Install agent hooks in current worktree
  dev3 install-skills                    Install agent skills globally
  dev3 projects list                    List all projects

Statuses: todo, in-progress, user-questions, review-by-ai, review-by-user
  ("completed" and "cancelled" are UI-only — they destroy the worktree)

@file syntax: any argument starting with @ reads from file (e.g. @plan.md).
  Double @@ for literal @.

Options: --project <id> (override auto-detect), --help, --version
`;


async function main(): Promise<void> {
	const rawArgs = process.argv.slice(2);

	if (rawArgs.length === 0 || rawArgs.includes("--help") || rawArgs.includes("-h")) {
		process.stdout.write(HELP);
		process.exit(0);
	}

	if (rawArgs.includes("--version") || rawArgs.includes("-v")) {
		process.stdout.write("dev3 cli v0.1.0\n");
		process.exit(0);
	}

	const command = rawArgs[0];
	const subcommand = rawArgs[1] && !rawArgs[1].startsWith("--") ? rawArgs[1] : undefined;
	const restArgs = subcommand ? rawArgs.slice(2) : rawArgs.slice(1);
	const args = resolveFileArgs(parseArgs(restArgs));

	const context = detectContext();
	const socketPath = resolveSocketPath();

	// Commands that work without the app running
	if (command === "current") {
		return await handleCurrent(socketPath);
	}
	if (command === "install-hooks") {
		return await handleInstallHooks(context);
	}
	if (command === "install-skills") {
		return await handleInstallSkills();
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
			case "label":
				return await handleLabel(subcommand, args, socketPath, context);
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
	process.stderr.write(`error: ${err.message || String(err)}\n`);
	process.exit(1);
});
