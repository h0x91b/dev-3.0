import { lstatSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Project, WorktreeAccessState } from "../shared/types";

/**
 * Why this exists: tmux `new-session`/`split-window -c <missing dir>` exits 0 and
 * starts the pane in `$HOME`, so an agent, a dev script or a column agent for a
 * task whose worktree is gone would run in the user's home directory. Every
 * task-scoped launcher calls {@link assertTaskWorkspacePresent} first, before any
 * trust, hook, config or env write and before any spawn.
 */
export class TaskWorkspaceUnavailableError extends Error {
	constructor(readonly state: Exclude<WorktreeAccessState, "present">, readonly path: string) {
		super(state === "unreadable"
			? `dev3 cannot read the task's worktree (${path}): permission denied. Nothing was started. `
				+ "Check that dev3 still has Full Disk Access — the worktree itself may be intact."
			: `The task's worktree is missing (${path}). Nothing was started — move the task to To Do to reset it, or cancel it.`);
		this.name = "TaskWorkspaceUnavailableError";
	}
}

function isMissingError(err: unknown): boolean {
	const code = (err as NodeJS.ErrnoException | undefined)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * `missing` only for a path the OS says is not there. A permission error is
 * `unreadable`: lost Full Disk Access makes an intact worktree look absent, and
 * treating it as gone would invite the user to reset live work.
 */
export function worktreeAccessState(path: string, opts: { requireGit?: boolean } = {}): WorktreeAccessState {
	try {
		if (!statSync(path).isDirectory()) return "missing";
	} catch (err) {
		if (isMissingError(err)) return "missing";
		return "unreadable";
	}
	if (!opts.requireGit) return "present";
	try {
		lstatSync(join(path, ".git"));
		return "present";
	} catch (err) {
		// A directory without its `.git` link is what git itself calls an already
		// removed worktree (decisions/2026/09/21/treat-a-lost-git-link-as-an-already-removed-worktree.md).
		if (isMissingError(err)) return "missing";
		return "unreadable";
	}
}

export function assertTaskWorkspacePresent(project: Pick<Project, "kind">, worktreePath: string | null | undefined): string {
	if (!worktreePath) throw new TaskWorkspaceUnavailableError("missing", "(no worktree recorded)");
	const state = worktreeAccessState(worktreePath, { requireGit: project.kind !== "virtual" });
	if (state !== "present") throw new TaskWorkspaceUnavailableError(state, worktreePath);
	return worktreePath;
}
