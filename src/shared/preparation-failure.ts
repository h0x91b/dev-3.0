/**
 * Preparation failures the renderer can explain in the user's language.
 *
 * A preparation error crosses RPC and lands in `task.preparationError` as a plain
 * English string, so the message built here is the contract between the thrower
 * (`createWorktree`) and the renderer. Both sides import it from this module.
 */

const START_BRANCH_MISSING = /^The branch "(.+)" this task starts from no longer exists\./;

/** English text for a task whose chosen start branch is gone (typically deleted after its PR merged). */
export function startBranchMissingMessage(branch: string): string {
	return `The branch "${branch}" this task starts from no longer exists. `
		+ "It was probably deleted after its pull request merged. "
		+ "Start a new task from another branch instead.";
}

export type PreparationFailure =
	| { kind: "start-branch-missing"; branch: string; rest: string }
	| { kind: "unknown" };

/** Recognize a known failure on the first line; `rest` keeps any lines appended after it. */
export function classifyPreparationFailure(errorText: string | null | undefined): PreparationFailure {
	if (!errorText) return { kind: "unknown" };
	const [first, ...rest] = errorText.split("\n");
	const match = START_BRANCH_MISSING.exec(first);
	if (!match) return { kind: "unknown" };
	return { kind: "start-branch-missing", branch: match[1], rest: rest.join("\n") };
}
