import { createInterface } from "node:readline/promises";
import type { Task } from "../../shared/types";
import { getTaskTitle } from "../../shared/types";
import { CLI_EXIT_CODE_LAUNCH_DECLINED, CLI_EXIT_CODE_NO_PROJECT_FOR_CWD } from "../../shared/cli-exit-codes";
import { resolveDev3Home } from "../../shared/dev3-home";
import { resolveUserHome } from "../../shared/user-home";
import { isPathInside } from "../../bun/conversation-search";
import { describeImportableSession, listImportableSessions, type ImportableSession } from "../../bun/session-import";
import { parseArgs } from "../args";
import { detectFromWorktreePath, listProjectsDirect, readTasksDirect, type ProjectDirect } from "../context";
import { rejectUnknownFlags } from "../flag-validation";
import { exitError, exitUsage, printTable } from "../output";
import { sendRequest } from "../socket-client";

/**
 * `dev3 import` — put an agent session that ran outside dev3 on the board.
 *
 * Run it from the shell the session ran in: the cwd is the discovery key. A
 * session is only ever importable into the project that owns its cwd, so there
 * is deliberately no --project override — importing elsewhere would fork a
 * branch in the wrong repository. See
 * decisions/2026/08/26/import-a-session-by-its-transcript.md.
 */

/** Creating the task builds a worktree and runs the setup script before it answers. */
const IMPORT_TIMEOUT_MS = 5 * 60_000;
/** The CLI socket refuses a request over 1 MB; the retelling gets most of it. */
const MAX_DESCRIPTION_BYTES = 512 * 1024;
const MAX_TABLE_TITLE = 60;

/** The registered project that owns `cwd`. Deepest path wins when projects nest. */
export function projectOwningPath(cwd: string, projects: ProjectDirect[]): ProjectDirect | null {
	let best: ProjectDirect | null = null;
	for (const project of projects) {
		if (project.deleted || project.kind === "virtual" || !project.path) continue;
		if (!isPathInside(cwd, project.path)) continue;
		if (!best || project.path.length > best.path.length) best = project;
	}
	return best;
}

/** The ref a new worktree forks from. A detached HEAD names no branch. */
function branchToFork(session: ImportableSession): string | undefined {
	const branch = session.gitBranch?.trim();
	if (!branch || branch === "HEAD") return undefined;
	return branch;
}

function claimedSessionIds(task: Record<string, unknown>): string[] {
	const panes = (task.sessionState as { panes?: Array<{ sessionId?: string }> } | undefined)?.panes ?? [];
	return panes.map((pane) => pane.sessionId).filter((id): id is string => Boolean(id));
}

function relativeAge(mtimeMs: number, now = Date.now()): string {
	const minutes = Math.max(0, Math.round((now - mtimeMs) / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

function clamp(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function exitNoProjectForCwd(cwd: string, projects: ProjectDirect[]): never {
	const lines = [
		"No dev3 project owns this directory:",
		`  ${cwd}`,
		"",
		"A session can only be imported into the project that owns the directory it ran",
		"in — anywhere else would fork a branch in the wrong repository — so registering",
		"the project first is a precondition, not something import can do for you.",
		"",
		"Next step:",
		'  1. In dev-3.0, click "+ Add Project", pick the "Local" tab, and choose this',
		`     repository (${cwd}, or the repository root above it).`,
		"  2. Come back to this directory and run `dev3 import` again.",
		"",
	];
	const registered = projects.filter((p) => p.path && p.kind !== "virtual" && !p.deleted);
	if (registered.length === 0) {
		lines.push("No projects are registered on this board yet.");
	} else {
		lines.push("Projects registered right now:");
		const names = registered.map((p) => p.name || p.id.slice(0, 8));
		const width = Math.max(...names.map((n) => n.length));
		registered.forEach((p, i) => lines.push(`  ${names[i].padEnd(width)}  ${p.path}`));
	}
	process.stderr.write(`${lines.join("\n")}\n`);
	process.exit(CLI_EXIT_CODE_NO_PROJECT_FOR_CWD);
}

function printSessions(sessions: ImportableSession[], project: ProjectDirect): void {
	process.stdout.write(`${sessions.length} importable session(s) under ${project.name} (${project.path}):\n\n`);
	printTable(
		["#", "TITLE", "TURNS", "BRANCH", "AGE", "SESSION"],
		sessions.map((session, i) => [
			String(i + 1),
			clamp(session.title?.trim() || "<no title>", MAX_TABLE_TITLE),
			String(session.turns),
			branchToFork(session) ?? "(detached)",
			relativeAge(session.mtimeMs),
			session.sessionId.slice(0, 8),
		]),
	);
	process.stdout.write(
		`\nImport one with:\n  dev3 import --session ${sessions[0].sessionId.slice(0, 8)}\n` +
		"Add --yes (-y) to skip the confirmation.\n",
	);
}

function pickSession(sessions: ImportableSession[], selector: string): ImportableSession {
	const matches = sessions.filter((s) => s.sessionId === selector || s.sessionId.startsWith(selector));
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) {
		exitError(`"${selector}" matches ${matches.length} sessions — use a longer id.`, matches.map((s) => s.sessionId).join("\n"));
	}
	exitError(
		`No importable session under this project matches "${selector}".`,
		"Run `dev3 import` with no arguments to list what is importable here.",
	);
}

function importSummary(project: ProjectDirect, session: ImportableSession, title: string): string {
	const branch = branchToFork(session);
	return [
		`Import into ${project.name}:`,
		`  title    ${title}`,
		`  session  ${session.sessionId.slice(0, 8)} (${session.source}, ${session.turns} turns)`,
		`  ran in   ${session.cwd}`,
		`  branch   ${branch
			? `${branch} — a fresh dev3 worktree forks from it`
			: `${project.defaultBaseBranch || "the project's base branch"} — the session recorded no branch`}`,
		"",
	].join("\n");
}

async function confirmImport(): Promise<boolean> {
	if (!process.stdin.isTTY) {
		exitUsage("Cannot ask for confirmation without a terminal — pass --yes (-y) to import unattended.");
	}
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await rl.question("Import this session? [y/N] ");
		return /^y(es)?$/i.test(answer.trim());
	} finally {
		rl.close();
	}
}

export async function handleImport(rawArgs: string[], socketPath: string): Promise<void> {
	const args = parseArgs(rawArgs.map((arg) => (arg === "-y" ? "--yes" : arg)));
	rejectUnknownFlags(args, ["session", "yes"]);

	const cwd = process.cwd();
	if (detectFromWorktreePath(cwd)) {
		exitError(
			"`dev3 import` runs where the session ran, and this is a dev3 worktree.",
			"Sessions started here are already tasks. Open the shell of your own checkout\nand run `dev3 import` there.",
		);
	}

	const projects = listProjectsDirect();
	const project = projectOwningPath(cwd, projects);
	if (!project) exitNoProjectForCwd(cwd, projects);

	const claimed = readTasksDirect(project.id).flatMap(claimedSessionIds);
	const sessions = listImportableSessions(project.path, {
		home: resolveUserHome(),
		dev3Home: resolveDev3Home(),
		excludeSessionIds: claimed,
	});

	const selector = args.flags.session?.trim();
	if (!selector) {
		if (sessions.length === 0) {
			process.stdout.write(
				`No importable sessions under ${project.name} (${project.path}).\n` +
				"Sessions that already ran inside a dev3 worktree, or that a task already owns, are not listed.\n",
			);
			return;
		}
		printSessions(sessions, project);
		return;
	}

	const session = pickSession(sessions, selector);
	const draft = describeImportableSession(session, { maxDescriptionBytes: MAX_DESCRIPTION_BYTES });
	if (!draft) {
		exitError(`Could not read the transcript of session ${session.sessionId.slice(0, 8)}.`, session.path);
	}
	const title = draft.title || `Imported ${session.source} session ${session.sessionId.slice(0, 8)}`;

	if (args.flags.yes !== "true") {
		process.stdout.write(importSummary(project, session, title));
		if (!(await confirmImport())) {
			process.stdout.write("Nothing imported.\n");
			process.exit(CLI_EXIT_CODE_LAUNCH_DECLINED);
		}
	}

	const branch = branchToFork(session);
	const resp = await sendRequest(socketPath, "task.create", {
		projectId: project.id,
		title,
		description: draft.description,
		...(branch ? { existingBranch: branch } : {}),
		importSession: { sessionId: session.sessionId, originCwd: session.cwd },
	}, { timeoutMs: IMPORT_TIMEOUT_MS });
	if (!resp.ok) exitError(resp.error || "Failed to import the session");

	const task = resp.data as Task;
	process.stdout.write(
		`Imported ${session.source} session ${session.sessionId.slice(0, 8)} as task ${task.id.slice(0, 8)} ` +
		`(seq ${task.seq}): ${getTaskTitle(task)}\n`,
	);
}
