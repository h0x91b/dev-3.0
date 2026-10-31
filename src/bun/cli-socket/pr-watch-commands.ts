import {
	PR_WATCH_MAX_PINNED_PRS,
	PR_WATCH_NO_PR_PREFIX,
	PR_WATCH_PR_FINISHED_PREFIX,
	PR_WATCH_UNTIL,
	pinnedPrNumbers,
	type PrWatch,
	type PrWatchUntil,
} from "../../shared/pr-watch";
import type { Project, Task } from "../../shared/types";
import * as git from "../git";
import * as github from "../github";
import { addPrWatch, clearPrWatches } from "../pr-watch-runner";
import { captureScheduledMessageAuthor } from "../scheduled-message-author";
import type { Handler } from "./shared";
import { resolveTaskFromParams } from "./task-resolution";

/** Every `gh` call here is capped, so the CLI's own socket timeout (set longer) never fires first. */
export const PR_WATCH_GH_TIMEOUT_MS = 15_000;

function noPr(message: string): Error {
	return new Error(`${PR_WATCH_NO_PR_PREFIX}${message}`);
}

/**
 * Without `--pr` the watch follows the open PR of the task's branch, which is what the
 * poller samples. A recorded PR that is no longer open is never a fallback: the agent
 * would be told about a finished PR while it waits for the new one.
 */
async function resolveBranchPr(project: Project, task: Task, worktree: string): Promise<{ number: number; url: string }> {
	const branch = (await git.getCurrentBranch(worktree)) ?? task.branchName ?? "";
	// Forced: the poller's cached "no PR" for this branch outlives a `dev3 pr create` run seconds ago.
	const { pr } = await github.findOpenPullRequest(project, worktree, branch, { timeoutMs: PR_WATCH_GH_TIMEOUT_MS, force: true });
	if (!pr) {
		throw noPr(`No open pull request found for ${branch || "this task"} (or GitHub did not answer in time). Open it with \`dev3 pr create\`, try again, or name any open PR of the repository with --pr <N>.`);
	}
	return { number: pr.number, url: pr.url };
}

type ResolvedPr = { number: number; url: string; pinned: false } | { number: number; url: string; pinned: true; headSha: string };

/**
 * `--pr N` is read by number, so any open PR of the project's repository works, fork
 * heads included. When it is the open PR of this task's own branch it is the branch
 * watch, exactly as without `--pr`; any other PR is pinned to its number.
 */
async function resolveNamedPr(project: Project, task: Task, worktree: string, prNumber: number): Promise<ResolvedPr> {
	const result = await github.readTaskPullRequest(project, worktree, "", prNumber, { timeoutMs: PR_WATCH_GH_TIMEOUT_MS, force: true });
	const pr = result?.pr;
	if (!pr || pr.number !== prNumber) {
		throw noPr(`No pull request #${prNumber} in this project's repository (or GitHub did not answer in time).`);
	}
	const state = typeof pr.state === "string" ? pr.state.toUpperCase() : "";
	if (state !== "OPEN") {
		throw new Error(`${PR_WATCH_PR_FINISHED_PREFIX}Pull request #${prNumber} is already ${state === "MERGED" ? "merged" : "closed"}; there is nothing left to watch.`);
	}
	const branch = await git.getCurrentBranch(worktree);
	// A review task's branch carries somebody else's head: its PR is followed, never adopted as the task's own.
	if (!task.foreignCode && branch && pr.headRefName === branch) {
		// A fork PR can share the branch name; only the PR the poller samples for this branch is the task's own.
		const own = await resolveBranchPr(project, task, worktree).catch(() => null);
		if (own?.number === prNumber) return { ...own, pinned: false };
	}
	if (typeof pr.headRefOid !== "string" || !pr.headRefOid) throw new Error(`GitHub returned no head commit for pull request #${prNumber}.`);
	return { number: prNumber, url: pr.url, pinned: true, headSha: pr.headRefOid };
}

function watchListing(watch: PrWatch) {
	return {
		until: watch.until, prNumber: watch.prNumber, headSha: watch.headSha.slice(0, 7), createdAt: watch.createdAt,
		...(watch.pinned ? { pinned: true } : {}),
	};
}

async function branchTips(worktree: string): Promise<string[]> {
	const branch = await git.getCurrentBranch(worktree);
	return branch ? (await git.getRemoteBranchTips(worktree, branch)).tips : [];
}

export const prWatchHandlers: Record<string, Handler> = {
	// `dev3 pr watch [--until ci|merged] [--pr N]`: store the subscription and return at once.
	"pr.watch.add": async (params) => {
		const until = params.until as PrWatchUntil;
		if (!PR_WATCH_UNTIL.includes(until)) throw new Error(`--until takes ${PR_WATCH_UNTIL.join(" or ")}.`);
		const { project, task } = await resolveTaskFromParams(params);
		const worktree = task.worktreePath;
		if (!worktree || task.status === "completed" || task.status === "cancelled") {
			throw new Error("Only a task with a live worktree can watch a pull request.");
		}
		const explicit = params.prNumber === undefined ? null : Number(params.prNumber);
		if (explicit !== null && !(Number.isInteger(explicit) && explicit > 0)) throw new Error("--pr takes a pull request number.");
		if (project.kind === "virtual") throw new Error("A task without a repository cannot watch a pull request.");
		const pr: ResolvedPr = explicit === null
			? { ...(await resolveBranchPr(project, task, worktree)), pinned: false }
			: await resolveNamedPr(project, task, worktree, explicit);
		if (pr.pinned) {
			const followed = pinnedPrNumbers(task.prWatches);
			if (!followed.includes(pr.number) && followed.length >= PR_WATCH_MAX_PINNED_PRS) {
				throw new Error(`This task already follows ${followed.length} other pull requests (the limit); drop one with \`dev3 pr watch --off --pr <N>\`.`);
			}
		}
		// A pinned watch starts at the PR's head on GitHub, which this worktree may not even have.
		const headSha = pr.pinned ? pr.headSha : await git.getHeadSha(worktree);
		if (!headSha) throw new Error("Could not read this worktree's HEAD.");

		// Loaded on demand: the lifecycle modules pull in the Electrobun-backed shared module.
		const [{ persistTaskPrIdentity }, { lifecycleActorRuntime }] = await Promise.all([
			import("../lifecycle/activities"),
			import("../lifecycle/service"),
		]);
		// The poller only watches tasks with a stored PR identity; this also replaces a stale one.
		// A pinned PR is never the task's own, so it never becomes its identity.
		if (!pr.pinned && pr.url) await persistTaskPrIdentity(project, task, pr.number, pr.url);
		// Only the agent that ran the command hears back, and only for its own task.
		const author = params.sourceTaskId === task.id
			? await captureScheduledMessageAuthor(
				task,
				typeof params.sourcePaneId === "string" ? params.sourcePaneId : null,
				typeof params.sourcePid === "number" ? params.sourcePid : null,
			)
			: null;
		const watch: PrWatch = {
			id: crypto.randomUUID(),
			until,
			prNumber: pr.number,
			headSha,
			createdAt: new Date().toISOString(),
			...(pr.pinned ? { pinned: true } : { tipsAtSubscribe: await branchTips(worktree) }),
			...(author ? { author } : {}),
		};
		await addPrWatch(project, task.id, watch);
		delete lifecycleActorRuntime(task.id).prNextDue;
		return { taskId: task.id, projectId: project.id, until, prNumber: pr.number, ...(pr.pinned ? { pinned: true } : {}) };
	},

	"pr.watch.list": async (params) => {
		const { project, task } = await resolveTaskFromParams(params);
		return { taskId: task.id, projectId: project.id, watches: (task.prWatches ?? []).map(watchListing) };
	},

	"pr.watch.off": async (params) => {
		const { project, task } = await resolveTaskFromParams(params);
		const prNumber = params.prNumber === undefined ? undefined : Number(params.prNumber);
		if (prNumber !== undefined && !(Number.isInteger(prNumber) && prNumber > 0)) throw new Error("--pr takes a pull request number.");
		return { taskId: task.id, projectId: project.id, removed: await clearPrWatches(project, task.id, prNumber) };
	},
};
