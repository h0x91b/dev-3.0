import { existsSync } from "node:fs";
import { CLI_FAILURE_WORKTREE_HALF_REMOVED } from "../shared/types";

/**
 * `git worktree remove` deletes the checkout itself and can stop half way
 * (a file appearing while it walks a big untracked tree, e.g. a `.venv`): the
 * `.git` link is gone, the files are not, and git will never touch the path
 * again. Only a dev3-managed task folder is ever finished off by hand.
 */
export function isHalfRemovedWorktree(path: string): boolean {
	return existsSync(path) && !existsSync(`${path}/.git`);
}

const HALF_REMOVED = "is half removed";

export class WorktreeHalfRemovedError extends Error {
	/** Forwarded by the CLI socket, which maps it onto its own exit code. */
	readonly cliReason = CLI_FAILURE_WORKTREE_HALF_REMOVED;

	constructor(readonly path: string, cause: string) {
		super(cause.includes(HALF_REMOVED)
			? cause
			: `The worktree at ${path} ${HALF_REMOVED}: git dropped its link, but files are still there (${cause}). ` +
				`Run the same move again to finish, or delete the folder yourself: rm -rf "${path}"`);
		this.name = "WorktreeHalfRemovedError";
	}
}
