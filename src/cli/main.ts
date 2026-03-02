import { parseArgs } from "./args";
import { detectContext, resolveSocketPath } from "./context";
import { exitAppNotRunning, exitUsage } from "./output";
import { handleProjects } from "./commands/projects";
import { handleTasks } from "./commands/tasks";
import { handleTask } from "./commands/task";
import { handleCurrent } from "./commands/current";

const HELP = `dev3 — control the dev-3.0 Kanban UI from the terminal

You are running inside a dev-3.0 managed worktree. This CLI lets you
communicate with the desktop app: update your task status, change the
title, create follow-up tasks, and more. Changes appear in the Kanban
board instantly.

When run from a worktree, --project and task <id> are auto-detected.
You almost never need to specify them explicitly.

━━━ Quick start (run these first) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  dev3 current                     Show your current project, task, and status
  dev3 task show                   Show full details of your current task

━━━ Update your task ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  dev3 task move --status review-by-ai
      Signal that your work is done and ready for AI review.

  dev3 task move --status user-questions
      You have questions for the user / need human input.

  dev3 task update --title "Fix auth race condition"
      Change the task title (shown on the Kanban card).

  dev3 task update --description "Refactored the login flow to..."
      Set a longer description (title auto-generated if omitted).

  dev3 task update --title "Fix auth" --description "Details here..."
      Update both at once.

━━━ Create follow-up tasks ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  dev3 task create --title "Add unit tests for auth module"
      Create a new task in To Do (same project, auto-detected).

━━━ Browse ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  dev3 tasks list                  List all tasks in your project
  dev3 tasks list --status todo    Filter by status
  dev3 projects list               List all projects

━━━ Allowed statuses for "task move" ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  todo              Move back to backlog
  in-progress       Actively working on it
  user-questions    Need human input / blocked on a question
  review-by-ai      Done, ready for automated review
  review-by-user    Done, ready for human review

  Note: "completed" and "cancelled" are not available via CLI because
  they destroy the worktree and terminal session.

━━━ Options ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  --project <id>    Override auto-detected project
  --help            Show this help
  --version         Show CLI version
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
	const args = parseArgs(restArgs);

	const context = detectContext();
	const socketPath = resolveSocketPath();

	// Commands that work without the app running
	if (command === "current") {
		return await handleCurrent(socketPath);
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
