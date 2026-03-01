#!/usr/bin/env bun

import { parseArgs } from "./args";
import { detectContext, resolveSocketPath } from "./context";
import { exitAppNotRunning, exitUsage } from "./output";
import { handleProjects } from "./commands/projects";
import { handleTasks } from "./commands/tasks";
import { handleTask } from "./commands/task";

const HELP = `dev3 — CLI for dev-3.0 project manager

Usage:
  dev3 <command> <subcommand> [options]

Commands:
  projects list                          List all projects
  tasks list [--project <id>] [--status] List tasks in a project
  task show [<id>] [--project <id>]      Show task details
  task create --project <id> --title "…" Create a new task
  task update [<id>] --title "…"         Update task title/description
  task move [<id>] --status <status>     Change task status

Statuses:
  todo, in-progress, user-questions, review-by-ai,
  review-by-user, completed, cancelled

Options:
  --project <id>  Specify project (auto-detected from worktree)
  --help          Show this help message
  --version       Show version

When run from inside a dev3 worktree, --project and task <id>
are auto-detected from the .dev3-marker file.
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
