import { parseArgs, resolveFileArgs } from "./args";
import { detectContext, resolveSocketPath } from "./context";
import { exitAppNotRunning, exitUsage } from "./output";
import { handleProjects } from "./commands/projects";
import { handleTasks } from "./commands/tasks";
import { handleTask } from "./commands/task";
import { handleCurrent } from "./commands/current";
import { handleNote } from "./commands/note";
import { handleLabel } from "./commands/label";

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

━━━ Notes (per-task scratchpad) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  dev3 note add "Found a race condition in auth"
      Add a note to the current task (source defaults to "ai").

  dev3 note add "User feedback" --source user
      Add a note with explicit source (user or ai).

  dev3 note list
      List all notes on the current task.

  dev3 note delete <note-id>
      Delete a note by ID (8-char prefix works).

━━━ Labels ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  dev3 label list                  List all labels in your project
  dev3 label create "bug"          Create a new label (auto-assigns color)
  dev3 label create "urgent" --color "#ef4444"
      Create a label with a specific color.
  dev3 label delete <label-id>     Delete a label (removes from all tasks)
  dev3 label set <label-id> [...]  Assign label(s) to current task
  dev3 label set --clear           Remove all labels from current task

━━━ Browse ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  dev3 tasks list                  List all tasks in your project
  dev3 tasks list --status todo    Filter by status
  dev3 tasks list --label <id>     Filter by label
  dev3 projects list               List all projects

━━━ Allowed statuses for "task move" ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  todo              Move back to backlog
  in-progress       Actively working on it
  user-questions    Need human input / blocked on a question
  review-by-ai      Done, ready for automated review
  review-by-user    Done, ready for human review

  Note: "completed" and "cancelled" are not available via CLI because
  they destroy the worktree and terminal session.

━━━ @file syntax ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Any flag value or positional argument starting with @ is read from
  a file. This is useful for large text content like descriptions.

  dev3 task update --description @plan.md
      Read plan.md and use its contents as the description.

  dev3 task create --title "My task" --description @notes.txt
      Create a task with description loaded from a file.

  dev3 note add @feedback.txt
      Add a note with content read from a file.

  To pass a literal @ as the first character, double it: @@literal

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
	const args = resolveFileArgs(parseArgs(restArgs));

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
