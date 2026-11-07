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

/** Why a start-after wait ended without starting anything. Nothing was launched, so it is not a launch failure. */
export type StartAfterAbandonReason = "gone" | "cancelled" | "no-pr" | "pr-closed";

const START_AFTER_ABANDONED: Record<StartAfterAbandonReason, { text: (seq: number) => string; pattern: RegExp }> = {
	"gone": {
		text: (seq) => `Did not start: task #${seq}, which this task waited for, no longer exists.`,
		pattern: /^Did not start: task #(\d+), which this task waited for, no longer exists\./,
	},
	"cancelled": {
		text: (seq) => `Did not start: task #${seq}, which this task waited for, was cancelled.`,
		pattern: /^Did not start: task #(\d+), which this task waited for, was cancelled\./,
	},
	"no-pr": {
		text: (seq) => `Did not start: task #${seq} was completed without a pull request, so there is no merge to wait for.`,
		pattern: /^Did not start: task #(\d+) was completed without a pull request/,
	},
	"pr-closed": {
		text: (seq) => `Did not start: the pull request of task #${seq} was closed without merging.`,
		pattern: /^Did not start: the pull request of task #(\d+) was closed without merging\./,
	},
};

/** English text stored on a task whose start-after wait was abandoned. */
export function startAfterAbandonedMessage(reason: StartAfterAbandonReason, seq: number): string {
	return START_AFTER_ABANDONED[reason].text(seq);
}

export type PreparationFailure =
	| { kind: "start-branch-missing"; branch: string; rest: string }
	| { kind: "start-after-abandoned"; reason: StartAfterAbandonReason; seq: number }
	| { kind: "unknown" };

/** Recognize a known failure on the first line; `rest` keeps any lines appended after it. */
export function classifyPreparationFailure(errorText: string | null | undefined): PreparationFailure {
	if (!errorText) return { kind: "unknown" };
	const [first, ...rest] = errorText.split("\n");
	const match = START_BRANCH_MISSING.exec(first);
	if (match) return { kind: "start-branch-missing", branch: match[1], rest: rest.join("\n") };
	for (const [reason, { pattern }] of Object.entries(START_AFTER_ABANDONED) as [StartAfterAbandonReason, { pattern: RegExp }][]) {
		const hit = pattern.exec(first);
		if (hit) return { kind: "start-after-abandoned", reason, seq: Number(hit[1]) };
	}
	return { kind: "unknown" };
}
