/**
 * The script a git-operation pane runs: rebase, merge, push.
 *
 * These were three hand-written `#!/bin/bash` blobs inside the RPC handlers, so
 * on Windows the pane was dead — it launched `/bin/bash`, which does not exist
 * there (Seq 1547, sibling of Seq 1544's launch fix).
 *
 * THE PORT IS NOT A TRANSLATION. The bash originals carried decisions as well as
 * commands — the merge script chose between `git checkout`, `git checkout --track
 * -b` and an error with an `if`/`elif`/`else` over two `git rev-parse --verify`
 * calls. Re-spelling that in PowerShell would leave one decision expressed twice
 * in two dialects that can drift. Every decision moved into TypeScript instead
 * (`git.refExists`, tested once on every platform), and what reaches the shell is
 * a LINEAR list of announced commands. The dialect only has to spell "run this
 * argv, capture the code, branch on it".
 *
 * WHY THE PANE STILL RUNS GIT AT ALL, rather than dev3 running it and printing
 * the result: the point of the pane is that the user watches git's own output
 * live — the conflict list, the push progress, the hook output — and is left
 * looking at the real message when it fails.
 */

import { launchDialect, indentLines } from "../shared/platform-launch";

export interface GitOpStep {
	/** English line printed before the command runs. Omit for a bare command. */
	announce?: string;
	/** The command, as argv. The dialect quotes every word. */
	command: string[];
	/**
	 * Nothing downstream depends on this step, so a non-zero exit is printed and
	 * ignored. The rebase's `git fetch` is the only one: a failed fetch has always
	 * let the rebase run against the refs already on disk.
	 */
	optional?: boolean;
	/** Name of the operation in this step's failure line, e.g. `Checkout`. */
	failureLabel?: string;
	/** Extra lines shown after this step's failure line (conflict guidance). */
	failureAdvice?: string[];
}

export interface GitOpScriptSpec {
	steps: GitOpStep[];
	/**
	 * Absolute path of the file receiving the final exit code. `monitorGitPane`
	 * reads it after the pane closes, so it must be the ONLY verdict written.
	 */
	exitFilePath: string;
	/** Success line, without the leading tick. */
	successMessage: string;
	/** How long the pane holds the success message before closing. */
	successHoldSeconds: number;
}

const CLOSE_PROMPT = "Press any key to close this pane.";

/**
 * The failing tail: git's own output is already on screen above this, so the
 * pane's job here is to say which step failed, add whatever guidance the caller
 * attached, and stay open until the user has read it.
 */
function failureTail(step: GitOpStep, exitVar: string, exitFilePath: string): string[] {
	const d = launchDialect();
	const label = step.failureLabel ?? "Command";
	return [
		d.writeExitCodeFile(exitVar, exitFilePath),
		d.print(d.style(`✗ ${label} failed (exit %s)`, "error"), { blankBefore: true, args: [d.exitCodeArg(exitVar)] }),
		...(step.failureAdvice ?? []).map((line) => d.print("%s", { args: [d.quote(line)] })),
		d.print(CLOSE_PROMPT, { blankBefore: true }),
		d.readKey(),
		d.exitWith(exitVar),
	];
}

function stepLines(step: GitOpStep, index: number, exitFilePath: string): string[] {
	const d = launchDialect();
	const exitVar = `__DEV3_EC${index}`;
	const lines: string[] = [];
	if (step.announce) lines.push(d.print("%s", { args: [d.quote(step.announce)] }));
	// The echoed command replaces `set -x`: the user sees exactly what ran, and
	// the dialect renders it identically for reading and for running.
	lines.push(d.print(d.style("$ %s", "dim"), { args: [d.quote(d.describeCommand(step.command))] }));
	lines.push(d.runCommand(step.command));
	lines.push(d.captureExitCode(exitVar));
	if (step.optional) {
		lines.push(
			...d.branchOnFailure(exitVar, {
				fail: indentLines(2, [
					d.print(d.style("! %s exited with %s — continuing", "dim"), {
						args: [d.quote(step.failureLabel ?? "Command"), d.exitCodeArg(exitVar)],
					}),
				]),
			}),
		);
		return lines;
	}
	lines.push(...d.branchOnFailure(exitVar, { fail: indentLines(2, failureTail(step, exitVar, exitFilePath)) }));
	return lines;
}

/**
 * Render the script. The LAST step must be a gating one: it is the step whose
 * exit code becomes the operation's verdict.
 */
export function buildGitOpScript(spec: GitOpScriptSpec): string {
	const d = launchDialect();
	const last = spec.steps[spec.steps.length - 1];
	if (!last || last.optional) {
		throw new Error("a git-op script must end in a gating step — its exit code is the operation's verdict");
	}
	return [
		...d.header(),
		...spec.steps.flatMap((step, index) => stepLines(step, index, spec.exitFilePath)),
		// Reached only when every gating step passed, so the last step's captured
		// code is zero — the same way the bash originals wrote their verdict.
		d.writeExitCodeFile(`__DEV3_EC${spec.steps.length - 1}`, spec.exitFilePath),
		d.print(d.style(`✓ ${spec.successMessage}`, "success"), { blankBefore: true }),
		d.sleepSeconds(spec.successHoldSeconds),
	].join("\n") + "\n";
}

// ── The three operations ──────────────────────────────────────────────────────
//
// Spec builders, not inline literals in the handlers, for ONE reason: the E2E
// that runs these scripts for real against a throwaway repo has to run the text
// the app ships. A test that rebuilt an equivalent step list would stay green
// while the handler drifted away from it.

export function rebaseGitOpSpec(opts: {
	exitFilePath: string;
	fetchBranch: string;
	rebaseTarget: string;
}): GitOpScriptSpec {
	return {
		exitFilePath: opts.exitFilePath,
		successMessage: "Rebase complete",
		successHoldSeconds: 5,
		steps: [
			{
				announce: "Fetching origin...",
				command: ["git", "fetch", "origin", opts.fetchBranch, "--quiet"],
				// Unchanged from the bash original: a failed fetch never blocked the
				// rebase, it just rebased onto the ref already on disk.
				optional: true,
				failureLabel: "Fetch",
			},
			{
				announce: `Rebasing on ${opts.rebaseTarget}...`,
				command: ["git", "rebase", opts.rebaseTarget],
				failureLabel: "Rebase",
				failureAdvice: [
					"Resolve conflicts in the main terminal, then: git rebase --continue",
					"Or abort with: git rebase --abort",
				],
			},
		],
	};
}

export function pushGitOpSpec(opts: { exitFilePath: string }): GitOpScriptSpec {
	return {
		exitFilePath: opts.exitFilePath,
		successMessage: "Push complete",
		successHoldSeconds: 2,
		steps: [{ command: ["git", "push", "origin", "HEAD"], failureLabel: "Push" }],
	};
}

/**
 * `checkoutCommand` is resolved by the caller (`git.refExists`), because that is
 * the decision this port moved out of the shell. `null` means the project is
 * already on the base branch.
 *
 * The commit message arrives as a FILE (`git commit -F`), never as `-m '<title>'`:
 * a title carrying a quote or a newline would have to survive two shell dialects,
 * and PowerShell 5.1's native-argument quoting mangles embedded double quotes.
 */
export function mergeGitOpSpec(opts: {
	exitFilePath: string;
	checkoutCommand: string[] | null;
	baseBranch: string;
	branchForMerge: string;
	messagePath: string;
}): GitOpScriptSpec {
	const steps: GitOpStep[] = [];
	if (opts.checkoutCommand) {
		steps.push({
			announce: `Switching project branch to ${opts.baseBranch}...`,
			command: opts.checkoutCommand,
			failureLabel: "Checkout",
		});
	}
	steps.push({
		announce: `Squash-merging ${opts.branchForMerge} into ${opts.baseBranch}...`,
		command: ["git", "merge", "--squash", opts.branchForMerge],
		failureLabel: "Merge",
	});
	steps.push({ command: ["git", "commit", "-F", opts.messagePath], failureLabel: "Commit" });
	return { exitFilePath: opts.exitFilePath, successMessage: "Merge complete", successHoldSeconds: 5, steps };
}

/**
 * The merge commit message on disk. Plain UTF-8, no BOM — `writeLaunchScript`
 * would prepend one on Windows and it would become the first bytes of the
 * commit subject.
 */
export async function writeMergeCommitMessage(messagePath: string, title: string): Promise<void> {
	await Bun.write(messagePath, `${title}\n`);
}
