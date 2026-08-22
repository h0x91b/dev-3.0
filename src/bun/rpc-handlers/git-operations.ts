import {
	type BranchStatus,
	type MergeRoute,
	type PRInfo,
	type Project,
	type Task,
	type TaskDiffMode,
	type TaskDiffResponse,
	type ScheduledMessageTarget,
	type UnsavedWork,
	getTaskTitle,
	resolveTaskCompareBaseBranch,
} from "../../shared/types";
import * as data from "../data";
import * as git from "../git";
import * as github from "../github";
import { DEFAULT_TMUX_SOCKET } from "../tmux";
import { dev3TaskTempPath } from "../temp-paths";
import { deliverAgentPrompt } from "../agent-prompt-delivery";
import type { AgentPromptDelivery } from "../../shared/agent-prompt-delivery";
import { buildTaskPrDeepLinkLine, deepLinkSchemeRegistered } from "../../shared/deep-link";
import { loadSettings } from "../settings";
import { auxPaneAlive, auxPaneTitle, openAuxPane } from "../task-aux-panes";
import {
	scheduleMessage as scheduleMessageCore,
	cancelScheduledMessage as cancelScheduledMessageCore,
	sendScheduledMessageNow as sendScheduledMessageNowCore,
} from "../scheduled-message-scheduler";
import { Semaphore } from "../concurrency";
import { syncTaskBranchName } from "../task-branch-sync";
import { getPushMessage, log } from "./shared";
import { generatedScriptLaunch, generatedScriptName, writeLaunchScript } from "./shared-pure";
import {
	buildGitOpScript,
	buildMergeCommitMessage,
	mergeGitOpSpec,
	pushGitOpSpec,
	rebaseGitOpSpec,
	writeMergeCommitMessage,
} from "../git-op-script";
import { launchDialectId } from "../../shared/platform-launch";
import { lifecycleActorRuntime } from "../lifecycle/service";
import {
	PR_DETECTION_TIMEOUT_MS,
	dismissMergeCompletionPrompt,
	persistProjectPrIdentities,
	persistTaskPrIdentity,
	prepareMergeCompletionPrompt,
	refreshTaskPrStatus,
} from "../lifecycle/activities";
import { getMergeCompletionFingerprint } from "../lifecycle/merge-fingerprint";

/**
 * Reject git-only RPCs for virtual (Operations) tasks. They have a working dir
 * but no git repo, so any git command would fail with a cryptic "not a git
 * repository". The UI already hides these affordances for virtual tasks; this is
 * defense-in-depth for CLI/programmatic callers and yields a clear error.
 */
function assertGitTask(project: Project, task: Task): asserts task is Task & { worktreePath: string } {
	if (project.kind === "virtual") {
		throw new Error("Git operations are not available for Operations tasks");
	}
	if (!task.worktreePath) {
		throw new Error("Task has no worktree");
	}
}

/**
 * Refuse the operations that WRITE to someone else's branch. A foreign-code task
 * exists to read commits the local user did not author — a PR review, a
 * colleague's branch — so pushing it, opening a PR for it, or squashing it into
 * the local base is never the intent, and every one of those is one mis-click away
 * in a bar that looks identical to a normal task's. The UI hides them too; this is
 * the seam that also covers the CLI and any programmatic caller.
 *
 * Read-only git stays available on purpose: diff, branch status, and rebase all
 * serve the review.
 */
function assertOwnBranch(task: Task, operation: string): void {
	if (task.foreignCode) {
		throw new Error(`${operation} is not available for a foreign-code task — this branch is not yours`);
	}
}

// Bound concurrent heavy branch-status runs across all tasks (see getBranchStatus).
const GIT_STATUS_MAX_CONCURRENCY = 4;
const branchStatusSemaphore = new Semaphore(GIT_STATUS_MAX_CONCURRENCY);
/**
 * Run a git operation's script in the task's auxiliary pane and watch it to
 * completion. Backend-neutral: the pane is a tmux split or a native SplitTree
 * pane depending on the task, and the seam replaces the pane this task already
 * owns so repeated clicks never stack two.
 *
 * The script is the same for both backends — it prints its own result and holds
 * the pane open (a keypress on failure, a few seconds on success) so the output
 * stays readable after the command itself has finished.
 */
async function openGitOpPane(task: Task, cwd: string, scriptPath: string, socket: string): Promise<string | null> {
	const handle = await openAuxPane({
		task,
		purpose: "gitOp",
		placement: "below",
		size: "20%",
		cwd,
		socket,
		title: auxPaneTitle("gitOp"),
		tmuxCommand: `bash "${scriptPath}"`,
		nativeLaunch: generatedScriptLaunch(scriptPath),
	});
	return handle.paneId || null;
}

/**
 * Script and verdict paths for one git operation. Deliberately ONE function: the
 * extension moves with the platform (`.sh` / `.ps1`), and the pane monitor used
 * to rebuild `git-<op>.sh.exit` by hand — a spelling that silently stops matching
 * the moment the script is not bash.
 */
function gitOpPaths(taskId: string, operation: string): { scriptPath: string; exitFilePath: string } {
	const scriptPath = dev3TaskTempPath(taskId, generatedScriptName(`git-${operation}`));
	return { scriptPath, exitFilePath: `${scriptPath}.exit` };
}

function monitorGitPane(paneId: string | null, task: Task, projectId: string, operation: string, socket: string): void {
	if (!paneId) return;
	const taskId = task.id;
	const { exitFilePath } = gitOpPaths(taskId, operation);

	let interval: ReturnType<typeof setInterval> | undefined;
	let safetyTimeout: ReturnType<typeof setTimeout> | undefined;

	function cleanup() {
		if (interval !== undefined) clearInterval(interval);
		if (safetyTimeout !== undefined) clearTimeout(safetyTimeout);
		interval = undefined;
		safetyTimeout = undefined;
	}

	try {
		interval = setInterval(async () => {
			try {
				// An unreadable pane set (session gone) counts as "no panes" so the
				// completion event still fires, exactly like the empty output did.
				const paneStillExists = await auxPaneAlive(task, "gitOp", socket);

				if (!paneStillExists) {
					cleanup();

					let ok = false;
					try {
						const exitCodeStr = await Bun.file(exitFilePath).text();
						ok = exitCodeStr.trim() === "0";
					} catch {}

					log.info("Git op pane closed", { taskId: taskId.slice(0, 8), operation, ok });
					getPushMessage()?.("gitOpCompleted", { taskId, projectId, operation, ok });
				}
			} catch {
				cleanup();
			}
		}, 1000);

		safetyTimeout = setTimeout(() => cleanup(), 10 * 60 * 1000);
	} catch {
		cleanup();
	}
}

/**
 * The ONE server-side answer to "which ref", for reading a status and for running
 * an action. Mirrors the renderer's `getDefaultTaskCompareRef` cascade so the ref
 * a button runs against is the ref the git bar named.
 */
function resolveCompareRef(project: Project, baseBranch: string, explicit?: string): Promise<string> {
	if (explicit) return Promise.resolve(explicit);
	// A task-specific base branch is local by definition — it was forked from a
	// branch in this repo, and origin/<it> usually does not exist at all.
	const projectBase = project.defaultBaseBranch || "main";
	if (baseBranch !== projectBase) return Promise.resolve(baseBranch);
	return git.resolveCompareRef(project.path, baseBranch);
}

/**
 * Retire a comparison base that has stopped being a base. A review-branch or
 * variant-source base is a moment in time: once that branch is merged into the
 * project base — or deleted outright — every number computed against it answers
 * a question nobody is asking, and "Rebase (AI)" points the agent at a dead
 * branch. Fall the task back to the project base and persist it, so the fix
 * outlives this poll. The user's `vs … ▾` override is unaffected: it lives in
 * renderer state, not in `task.baseBranch`.
 */
async function healDeadCompareBase(project: Project, task: Task, baseBranch: string): Promise<string> {
	const projectBase = project.defaultBaseBranch || "main";
	if (baseBranch === projectBase || task.baseBranch !== baseBranch) return baseBranch;

	const reason = !await git.refExists(project.path, baseBranch)
		? "gone"
		: await git.isRefMergedInto(project.path, baseBranch, await resolveCompareRef(project, projectBase))
			? "merged"
			: null;
	if (!reason) return baseBranch;

	log.info("Retiring stale comparison base", { taskId: task.id.slice(0, 8), baseBranch, projectBase, reason });
	try {
		const updated = await data.updateTask(project, task.id, { baseBranch: projectBase });
		getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
	} catch (err) {
		log.warn("Failed to retire stale comparison base", { taskId: task.id.slice(0, 8), error: String(err) });
	}
	return projectBase;
}

async function getBranchStatusImpl(params: { taskId: string; projectId: string; compareRef?: string }): Promise<BranchStatus> {
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);

	// Virtual (Operations) tasks have a working dir but no git repo. The renderer
	// polls this every 15s for any active task with a worktreePath, so return an
	// inert status instead of spawning a doomed `git` in a non-repo directory.
	if (project.kind === "virtual" || !task.worktreePath) {
		return { ahead: 0, behind: 0, canRebase: false, insertions: 0, deletions: 0, unpushed: 0, mergedByContent: false, diffFiles: 0, diffInsertions: 0, diffDeletions: 0, diffFileStats: [], prNumber: null, prUrl: null, mergeCompletionFingerprint: null, hasRemote: false, remoteIsGitHub: false, remoteAhead: 0 };
	}

	const resolvedBase = resolveTaskCompareBaseBranch(task, project);
	const liveBranch = await git.getCurrentBranch(task.worktreePath);
	const branchForPush = liveBranch ?? task.branchName ?? "";

	if (liveBranch && liveBranch !== task.branchName) {
		await syncTaskBranchName(project, task);
	}

	// Nothing to fetch without a remote — the doomed `git fetch origin <base>` was
	// spawned on every 15s poll of a local-only project and always failed.
	const hasRemote = await git.hasOriginRemote(project.path);
	if (hasRemote) {
		log.debug("getBranchStatus: fetching origin", { worktreePath: task.worktreePath, baseBranch: resolvedBase, branchName: branchForPush });
		await git.fetchCompareRef(project.path, resolvedBase);
	}
	const baseBranch = await healDeadCompareBase(project, task, resolvedBase);
	const ref = await resolveCompareRef(project, baseBranch, params.compareRef);
	const compareRefBranch = params.compareRef?.startsWith("origin/") ? params.compareRef.slice("origin/".length) : null;
	if (compareRefBranch && compareRefBranch !== baseBranch) {
		await git.fetchCompareRef(project.path, compareRefBranch);
	}
	// Also refresh origin/<task-branch> so getUnpushedCount reflects out-of-band remote pushes.
	if (hasRemote && branchForPush && branchForPush !== baseBranch && branchForPush !== compareRefBranch) {
		await git.fetchOrigin(project.path, branchForPush);
	}
	/**
	 * PR detection, which doubles as the "can `gh` work here at all" probe. gh's
	 * refusal on a non-GitHub remote is definitive and free — this call already
	 * runs every poll — so no separate round trip is needed. Anything else (a
	 * timeout, no auth, no gh) leaves `isGitHub` true; see
	 * `github.isNotAGitHubRepoError` for why that polarity is the safe one.
	 */
	const prDetection: Promise<github.OpenPullRequestProbe> = (async () => {
		try {
			const probe = await github.findOpenPullRequest(project, task.worktreePath!, branchForPush, {
				timeoutMs: PR_DETECTION_TIMEOUT_MS,
			});
			if (probe.pr?.url) await persistTaskPrIdentity(project, task, probe.pr.number, probe.pr.url);
			return probe;
		} catch (err) {
			log.warn("PR detection failed (non-fatal)", { error: String(err) });
		}
		return { pr: null, isGitHub: true };
	})();

	const [status, uncommitted, unpushed, remoteAhead, branchDiff, detected] = await Promise.all([
		git.getBranchStatus(task.worktreePath, ref),
		git.getUncommittedChanges(task.worktreePath),
		git.getUnpushedCount(task.worktreePath, branchForPush),
		// origin/<branch> was refreshed above, so this is the live answer to "would a
		// plain push be refused as non-fast-forward".
		hasRemote ? git.getBehindOriginCount(task.worktreePath, branchForPush) : Promise.resolve(0),
		git.getBranchDiffStats(task.worktreePath, ref),
		prDetection,
	]);
	const remoteIsGitHub = hasRemote && detected.isGitHub;
	let prInfo = detected.pr;
	if (!prInfo && task.prNumber != null && task.prUrl) {
		// The sticky number outlives the branch it was opened from: rename the
		// branch, or inherit the number from the review task this one grew out of,
		// and it points at a stranger's PR. Show it only while GitHub says the PR
		// is about this branch. No answer at all (offline, non-GitHub remote) keeps
		// the stored pair — better a stale badge than one that blinks out.
		const snapshot = await github.getPullRequestSnapshot(project, task.worktreePath, task.prNumber);
		if (!snapshot || !branchForPush || snapshot.headRefName === branchForPush) {
			prInfo = { number: task.prNumber, url: task.prUrl };
		} else {
			log.info("Ignoring stored PR from a different branch", {
				taskId: task.id.slice(0, 8), pr: task.prNumber, prHead: snapshot.headRefName, branch: branchForPush,
			});
		}
	}
	const prNumber = prInfo?.number ?? null;
	const prUrl = prInfo?.url ?? null;
	log.debug("getBranchStatus: raw results", { status, uncommitted, unpushed, branchDiff, prNumber, prUrl, ref });
	const canRebase = status.behind > 0 ? await git.canRebaseCleanly(task.worktreePath, ref) : false;
	// ahead === 0 means HEAD is an ancestor of `ref`: every commit of this branch
	// is already in the base, so content strategies would trivially say "merged".
	// Git alone cannot tell "merged, then rebased away" from "brand-new branch,
	// nothing committed yet" — only this task's own merged PR proves work landed.
	// No PR (or no GitHub / offline) ⇒ not merged, never a false positive.
	const prNumberForMergeProof = prInfo?.number ?? null;
	const mergedByContent = status.ahead > 0
		? await git.isContentMergedInto(task.worktreePath, ref, project) === true
		: prNumberForMergeProof != null
			&& await github.isPullRequestMerged(project, task.worktreePath, prNumberForMergeProof, branchForPush || null) === true;
	const mergeCompletionFingerprint = mergedByContent
		? (await getMergeCompletionFingerprint(task, branchForPush)).fingerprint
		: null;

	const result = {
		...status, canRebase, ...uncommitted, unpushed, mergedByContent,
		diffFiles: branchDiff.files, diffInsertions: branchDiff.insertions, diffDeletions: branchDiff.deletions, diffFileStats: branchDiff.fileStats,
		prNumber, prUrl,
		mergeCompletionFingerprint,
		hasRemote, remoteIsGitHub, remoteAhead,
	};
	log.debug("← getBranchStatus", result);

	git.saveDiffSnapshot(project, task, ref).catch((err) => {
		log.warn("saveDiffSnapshot failed", { taskId: task.id, error: String(err) });
	});

	return result;
}

/**
 * Local-only "what would deleting this worktree destroy?" — the completion
 * dialog's data source. Three cheap `git` reads, no fetch, no `gh`, no
 * semaphore, so it answers in milliseconds and can be awaited in front of the
 * user. Use `getBranchStatus` when remote truth actually matters.
 */
async function getUnsavedWork(params: { taskId: string; projectId: string }): Promise<UnsavedWork> {
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	if (project.kind === "virtual" || !task.worktreePath) {
		return { insertions: 0, deletions: 0, unpushed: 0, ahead: 0 };
	}

	const liveBranch = await git.getCurrentBranch(task.worktreePath);
	const branchForPush = liveBranch ?? task.branchName ?? "";
	const ref = await resolveCompareRef(project, resolveTaskCompareBaseBranch(task, project));
	const [uncommitted, unpushed, counts] = await Promise.all([
		git.getUncommittedChanges(task.worktreePath),
		git.getUnpushedCount(task.worktreePath, branchForPush),
		git.getBranchStatus(task.worktreePath, ref),
	]);
	return { ...uncommitted, unpushed, ahead: counts.ahead };
}

async function getBranchStatus(params: { taskId: string; projectId: string; compareRef?: string }) {
	log.debug("→ getBranchStatus", params);
	const dedupKey = `${params.taskId}:${params.compareRef ?? ""}`;
	const runtime = lifecycleActorRuntime(params.taskId);
	const inFlight = runtime.branchChecks ??= new Map();
	const existing = inFlight.get(dedupKey);
	if (existing) {
		log.debug("getBranchStatus: reusing in-flight request", { taskId: params.taskId });
		return existing;
	}

	// Cap cross-task concurrency: each impl run spawns `git fetch` + `gh` + many
	// local git commands. A wave of panels polling at once (e.g. on wake) would
	// otherwise fork dozens of git processes simultaneously and choke the machine.
	const promise = branchStatusSemaphore.run(() => getBranchStatusImpl(params));
	inFlight.set(dedupKey, promise);
	try {
		return await promise;
	} finally {
		inFlight.delete(dedupKey);
	}
}

async function getTaskDiff(params: {
	taskId: string;
	projectId: string;
	mode: TaskDiffMode;
	compareRef?: string;
	compareLabel?: string;
	count?: number;
}): Promise<TaskDiffResponse> {
	log.info("→ getTaskDiff", params);
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);

	assertGitTask(project, task);

	const baseBranch = resolveTaskCompareBaseBranch(task, project);
	// `uncommitted` needs no remote ref; `recent` is purely local — it diffs
	// `HEAD~N..HEAD` and clamps against the already on-disk `origin/<base>`
	// merge-base — so neither pays for a network fetch.
	if (params.mode !== "uncommitted" && params.mode !== "recent" && await git.hasOriginRemote(project.path)) {
		await git.fetchCompareRef(project.path, baseBranch);
		const compareRefBranch = params.compareRef?.startsWith("origin/") ? params.compareRef.slice("origin/".length) : null;
		if (compareRefBranch && compareRefBranch !== baseBranch) {
			await git.fetchCompareRef(project.path, compareRefBranch);
		}
	}

	// `uncommitted` never touches the compare ref and `recent` only clamps against
	// it, so neither pays for resolving one.
	const compareRef = params.mode === "uncommitted" || params.mode === "recent"
		? params.compareRef
		: await resolveCompareRef(project, baseBranch, params.compareRef);

	const result = await git.getTaskDiff(task.worktreePath, params.mode, {
		baseBranch,
		compareRef,
		compareLabel: params.compareLabel,
		count: params.count,
	});
	const skippedBinary = result.skippedFiles.filter((f) => f.reason === "binary").length;
	const skippedLarge = result.skippedFiles.filter((f) => f.reason === "too-large").length;
	log.info("← getTaskDiff", {
		mode: result.mode,
		files: result.files.length,
		binary: skippedBinary,
		large: skippedLarge,
		fallbackReason: result.fallbackReason,
	});
	return result;
}

async function rebaseTask(params: { taskId: string; projectId: string; compareRef?: string }): Promise<void> {
	log.info("→ rebaseTask", params);
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);

	assertGitTask(project, task);

	const baseBranch = resolveTaskCompareBaseBranch(task, project);
	// The ref the UI promised, resolved the same way the status readout resolves
	// it. `origin/${baseBranch}` here is what rebased a remoteless repo onto a ref
	// that does not exist.
	const rebaseTarget = await resolveCompareRef(project, baseBranch, params.compareRef);

	// Fetch exactly the ref we rebase onto, and only when it is a remote one. A
	// local base branch is already current, and a repo with no remote must not be
	// made to fetch at all.
	const fetchBranch = rebaseTarget.startsWith("origin/")
		? rebaseTarget.slice("origin/".length)
		: null;

	// `exit 128 — invalid upstream` opened a pane only to die, then told the user
	// to resolve conflicts that do not exist. Refuse before the pane opens — but
	// give a remote ref its fetch first, since that is what would create it.
	if (!await git.refExists(task.worktreePath, rebaseTarget)) {
		if (fetchBranch) await git.fetchCompareRef(project.path, fetchBranch);
		if (!await git.refExists(task.worktreePath, rebaseTarget)) {
			throw new Error(`Cannot rebase: ${rebaseTarget} does not exist in this repository`);
		}
	}

	const { scriptPath, exitFilePath } = gitOpPaths(task.id, "rebase");
	const socket = task.tmuxSocket ?? DEFAULT_TMUX_SOCKET;

	await writeLaunchScript(scriptPath, buildGitOpScript(rebaseGitOpSpec({ exitFilePath, fetchBranch, rebaseTarget })));

	const paneId = await openGitOpPane(task, task.worktreePath, scriptPath, socket);
	monitorGitPane(paneId, task, params.projectId, "rebase", socket);

	log.info("← rebaseTask (pane opened)", { paneId });
}

/** How long `gh pr merge` may take before we stop waiting on it. */
const PR_MERGE_TIMEOUT_MS = 60_000;

/**
 * Merge the branch's open PR through GitHub. This is what "Merge" means whenever
 * a PR exists, and it is deliberately NOT a pane script:
 *
 *  - `gh pr merge` is one API call whose entire output is a line or two, so there
 *    is nothing to watch live — the reason the local git operations get a pane.
 *  - a pane cannot carry the project's gh credential without the bash-only
 *    `getGitHubShellExports` prelude, which is exactly what keeps
 *    `openPullRequest` unavailable on Windows.
 *
 * Branch protection, required reviews and CI gates stay GitHub's to enforce —
 * that is the whole point of merging the PR instead of squashing locally.
 *
 * No `--delete-branch`: the head branch is checked out in the task's worktree, so
 * gh's local delete would fail AFTER the merge already happened and report the
 * whole operation as failed. dev3 removes worktree and branch on task completion.
 */
async function mergeViaPullRequest(
	project: Project,
	task: Task & { worktreePath: string },
	prNumber: number,
	baseBranch: string,
): Promise<void> {
	const method = await github.resolveMergeMethod(project, task.worktreePath);
	log.info("mergeTask: merging the pull request via gh", { taskId: task.id.slice(0, 8), prNumber, method });
	const result = await github.runGitHub(
		project,
		task.worktreePath,
		["pr", "merge", String(prNumber), `--${method}`],
		{ timeoutMs: PR_MERGE_TIMEOUT_MS },
	);
	if (!result.ok) {
		// gh's own message is the useful one — "not mergeable", "review required",
		// "checks are pending" — so it reaches the user's toast verbatim.
		throw new Error(result.stderr || result.stdout || `gh pr merge #${prNumber} failed (exit ${result.code})`);
	}
	// The local clone still points at the pre-merge base, and both the branch-status
	// poll and the "task done?" offer read origin/<base>.
	await git.fetchOrigin(project.path, baseBranch);
	getPushMessage()?.("gitOpCompleted", { taskId: task.id, projectId: project.id, operation: "merge", ok: true });
	log.info("← mergeTask (pull request merged)", { prNumber, method });
}

/**
 * Merge takes one of two routes, and which one is a property of the repo, not a
 * setting: an open PR for this branch means merge THAT (the user's expectation,
 * and the only route that respects review and CI), and no PR means the local
 * squash into the base branch.
 *
 * `expectRoute` is the renderer's belief, sent along like the push lease's sha:
 * the button already told the user which of the two it would do, so a mismatch is
 * refused instead of silently running the other one — a local squash-and-push
 * behind a confirm that said "merge the PR" is the worst outcome available here.
 */
async function mergeTask(params: { taskId: string; projectId: string; expectRoute?: MergeRoute; compareRef?: string }): Promise<void> {
	log.info("→ mergeTask", params);
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);

	assertGitTask(project, task);
	assertOwnBranch(task, "Merge");

	const liveBranch = await git.getCurrentBranch(task.worktreePath);
	const branchForMerge = liveBranch ?? task.branchName;
	if (!branchForMerge) throw new Error("Task has no branch");

	const baseBranch = resolveTaskCompareBaseBranch(task, project);

	let openPr: { number: number; url: string } | null = null;
	try {
		openPr = (await github.findOpenPullRequest(project, task.worktreePath, branchForMerge, {
			timeoutMs: PR_DETECTION_TIMEOUT_MS,
		})).pr;
	} catch (err) {
		// No gh, no auth, no network: fall through to the local route, which is what
		// this button did for its whole life.
		log.warn("mergeTask: PR lookup failed, falling back to the local squash", { error: String(err) });
	}
	if (params.expectRoute === "pull-request" && !openPr) {
		throw new Error("No open pull request for this branch any more — refresh the branch status");
	}
	if (params.expectRoute === "local-squash" && openPr) {
		throw new Error(`Pull request #${openPr.number} is open for this branch — refresh the branch status, Merge will merge the PR`);
	}
	if (openPr) {
		await mergeViaPullRequest(project, task, openPr.number, baseBranch);
		return;
	}

	if (await git.hasOriginRemote(project.path)) await git.fetchOrigin(project.path, baseBranch);
	// The ref the UI measured "N behind" against — passed in by the caller, resolved
	// here when it owns the choice. Spelled `origin/<base>` this guard measured
	// against a ref that does not exist in a remoteless repo, so it never fired.
	const rebaseCheckRef = await resolveCompareRef(project, baseBranch, params.compareRef);
	const status = await git.getBranchStatus(task.worktreePath, rebaseCheckRef);
	if (status.behind > 0) throw new Error("Branch is not rebased — rebase first");

	const { scriptPath, exitFilePath } = gitOpPaths(task.id, "merge");
	const socket = task.tmuxSocket ?? DEFAULT_TMUX_SOCKET;

	// The pane's cwd IS the project path, so the bash original's leading `cd` was
	// already redundant; the branch choice below used to be an if/elif/else over two
	// `git rev-parse --verify` calls INSIDE the script, and is now decided here,
	// once, for every platform.
	const currentBranch = await git.getCurrentBranch(project.path);
	let checkoutCommand: string[] | null = null;
	if (currentBranch !== baseBranch) {
		// remote-base-ok: not a comparison ref — the local base is missing, so this
		// asks whether a tracking branch can be created from the remote one, and
		// `refExists` answers no when there is no remote.
		checkoutCommand = await git.refExists(project.path, baseBranch)
			? ["git", "checkout", baseBranch]
			: await git.refExists(project.path, `origin/${baseBranch}`)
				? ["git", "checkout", "--track", "-b", baseBranch, `origin/${baseBranch}`]
				: null;
		// Used to be an in-pane message and exit 1. Refusing here surfaces it in the
		// UI instead of in a pane that opens only to say it cannot do anything.
		if (!checkoutCommand) throw new Error(`Base branch ${baseBranch} does not exist locally or on origin`);
	}

	// The subject comes from the branch's own commits or the task title — never
	// from `task.title` alone, which is the first 80 characters of the DESCRIPTION
	// whenever nobody renamed the task, ellipsis included.
	const messagePath = dev3TaskTempPath(task.id, "git-merge-message.txt");
	const commits = await git.listBranchCommitMessages(task.worktreePath, rebaseCheckRef);
	await writeMergeCommitMessage(messagePath, buildMergeCommitMessage({
		commits,
		taskTitle: getTaskTitle(task),
		branchName: branchForMerge,
	}));

	// With a remote, "merge" that stops at the local base branch is a half-landing:
	// the squash commit sits in the main clone, origin/<base> never hears about it,
	// and nothing in the UI says the local base is ahead. The renderer confirms the
	// click first, naming the review/CI bypass.
	// remote-base-ok: the question here IS "does the remote base exist", asked
	// behind hasOriginRemote — not a comparison ref invented for a local repo.
	const pushBase = await git.hasOriginRemote(project.path)
		&& await git.refExists(project.path, `origin/${baseBranch}`);

	await writeLaunchScript(scriptPath, buildGitOpScript(mergeGitOpSpec({
		exitFilePath,
		checkoutCommand,
		baseBranch,
		branchForMerge,
		messagePath,
		pushBase,
	})));

	const paneId = await openGitOpPane(task, project.path, scriptPath, socket);
	monitorGitPane(paneId, task, params.projectId, "merge", socket);

	log.info("← mergeTask (pane opened)", { paneId, pushBase });
}

/**
 * Push, escalating to a leased force push when the branch has diverged from
 * `origin/<branch>` — which it has after every rebase-then-push, the single most
 * common git failure in the app. A plain push there is refused as non-fast-forward
 * and the pane could only print `✗ Push failed (exit 1)`.
 *
 * The decision is made HERE, not in the renderer: the caller cannot ask for a
 * force. The renderer reads the same `remoteAhead` to label the button, so what it
 * promises and what runs come from one number.
 *
 * The lease value is a sha resolved after a fresh fetch, so git compares it
 * against origin's real value during the handshake and refuses if anyone moved the
 * branch in between. Divergence with nothing to fetch (no `origin/<branch>` at
 * all) cannot happen — that is the never-pushed case, and a plain push is right.
 */
async function pushTask(params: { taskId: string; projectId: string }): Promise<void> {
	log.info("→ pushTask", params);
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);

	assertGitTask(project, task);
	assertOwnBranch(task, "Push");

	const { scriptPath, exitFilePath } = gitOpPaths(task.id, "push");
	const socket = task.tmuxSocket ?? DEFAULT_TMUX_SOCKET;

	const branch = (await git.getCurrentBranch(task.worktreePath)) ?? task.branchName ?? "";
	let lease: { branch: string; expectSha: string } | null = null;
	if (branch && await git.hasOriginRemote(project.path)) {
		await git.fetchOrigin(project.path, branch);
		const diverged = await git.getBehindOriginCount(task.worktreePath, branch);
		if (diverged > 0) {
			const expectSha = await git.resolveRef(task.worktreePath, `origin/${branch}`);
			if (!expectSha) throw new Error(`Cannot lease a force push: origin/${branch} could not be resolved`);
			lease = { branch, expectSha };
			log.info("pushTask: branch diverged from origin, leasing a force push", {
				taskId: task.id.slice(0, 8), branch, diverged, expectSha: expectSha.slice(0, 8),
			});
		}
	}

	await writeLaunchScript(scriptPath, buildGitOpScript(pushGitOpSpec({ exitFilePath, lease })));

	const paneId = await openGitOpPane(task, task.worktreePath, scriptPath, socket);
	monitorGitPane(paneId, task, params.projectId, "push", socket);

	log.info("← pushTask (pane opened)", { paneId, forced: lease !== null });
}

/**
 * PR handoff prompt. `deepLinkLine` is the footer content the agent appends so the
 * PR carries a deep link back to the originating task (one source of truth in
 * `shared/deep-link.ts`), or null when the user opted out.
 *
 * Two rules hold this together:
 *  - The whole prompt stays on ONE line. It is typed into the pane as raw bytes, so
 *    an embedded newline can submit it early on an agent that reads `\n` as Enter —
 *    hence the `---` divider is described in words rather than embedded.
 *  - The link goes LAST. It ends the prompt, and any sentence behind it would read
 *    as part of the line the agent was told to copy exactly.
 */
function createPrAgentPrompt(deepLinkLine: string | null, autoMerge: boolean): string {
	const base =
		"Please push this branch and open a pull request for it using the gh CLI (first run git push, then gh pr create). Choose an appropriate title and description based on the work in this conversation.";
	const merge = autoMerge
		? " Finally, enable auto-merge on the PR with gh pr merge --auto so it merges automatically once checks pass."
		: "";
	const deepLink = deepLinkLine
		? ` End the PR description with a blank line, then a \`---\` divider on its own line, then exactly this line so reviewers can jump straight back to the originating dev3 task: ${deepLinkLine}`
		: "";
	return base + merge + deepLink;
}

const COMMIT_AGENT_PROMPT =
	"Please commit the current changes in this worktree. Review what changed (git status, git diff), stage everything that belongs to the work in this conversation, and create one or more commits with clear English messages describing the change. Do not push.";

function rebaseConflictAgentPrompt(rebaseTarget: string): string {
	// The fetch belongs to a remote target only — telling an agent in a repo with
	// no remote to `git fetch origin` sends it chasing a failure of our making.
	const fetch = rebaseTarget.startsWith("origin/") ? "run `git fetch origin`, then " : "";
	return `This branch cannot be rebased automatically onto ${rebaseTarget} because of merge conflicts. Please rebase it and resolve the conflicts: ${fetch}\`git rebase ${rebaseTarget}\`, resolve each conflict carefully preserving the intent of both sides, \`git add\` the resolved files, and \`git rebase --continue\` until the rebase finishes. If it becomes unsafe, abort with \`git rebase --abort\` and explain what happened.`;
}

/**
 * PR handoff: the agent pushes the branch and runs `gh pr create` itself, because the
 * title and description come from the conversation. Returns the delivery verdict so the
 * UI can confirm the handoff, warn that no terminal exists, or say it could not be
 * confirmed — the same three answers its rebase and commit siblings give.
 */
async function createPullRequest(params: { taskId: string; projectId: string; autoMerge?: boolean }): Promise<{ delivery: AgentPromptDelivery }> {
	log.info("→ createPullRequest", params);
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);

	assertGitTask(project, task);
	assertOwnBranch(task, "Create pull request");

	if (!await github.isGitHubRepo(project, task.worktreePath)) {
		throw new Error("Create pull request needs a GitHub remote — `gh` is the only forge client dev3 speaks");
	}

	// Only macOS registers a `dev3://` handler, so anywhere else the footer would
	// publish a dead link into a public PR — the host decides before the preference does.
	const linkOptOut =
		!deepLinkSchemeRegistered(process.platform) || (await loadSettings()).prOriginTaskLink === false;
	const prompt = createPrAgentPrompt(
		linkOptOut ? null : buildTaskPrDeepLinkLine(task.id),
		params.autoMerge ?? false,
	);
	const delivery = await deliverAgentPrompt(task, prompt);
	log.info("← createPullRequest", { taskId: task.id.slice(0, 8), status: delivery.status, reason: delivery.reason });
	return { delivery };
}

/**
 * Rebase-conflict handoff: when `git rebase` cannot apply cleanly (canRebase is
 * false), the UI routes the Rebase button here instead of opening a doomed
 * auto-rebase pane. We ask the agent in the task terminal to perform the rebase
 * and resolve the conflicts. Returns the delivery verdict so the UI can confirm the
 * handoff, warn that no terminal exists, or say it could not be confirmed.
 */
async function rebaseTaskViaAgent(params: { taskId: string; projectId: string; compareRef?: string }): Promise<{ delivery: AgentPromptDelivery }> {
	log.info("→ rebaseTaskViaAgent", params);
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);

	assertGitTask(project, task);

	const baseBranch = resolveTaskCompareBaseBranch(task, project);
	const rebaseTarget = await resolveCompareRef(project, baseBranch, params.compareRef);
	const delivery = await deliverAgentPrompt(task, rebaseConflictAgentPrompt(rebaseTarget));
	log.info("← rebaseTaskViaAgent", { taskId: task.id.slice(0, 8), status: delivery.status, reason: delivery.reason });
	return { delivery };
}

/**
 * Commit handoff: the git row's Commit button never runs `git commit` itself —
 * choosing what to stage and how to word the message is exactly the agent's job
 * (issue #271). Mirrors the Create-PR / rebase-conflict handoffs and returns the
 * delivery verdict.
 */
async function commitTaskViaAgent(params: { taskId: string; projectId: string }): Promise<{ delivery: AgentPromptDelivery }> {
	log.info("→ commitTaskViaAgent", params);
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);

	assertGitTask(project, task);

	const delivery = await deliverAgentPrompt(task, COMMIT_AGENT_PROMPT);
	log.info("← commitTaskViaAgent", { taskId: task.id.slice(0, 8), status: delivery.status, reason: delivery.reason });
	return { delivery };
}

async function openPullRequest(params: { taskId: string; projectId: string }): Promise<void> {
	log.info("→ openPullRequest", params);
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);

	assertGitTask(project, task);

	// The ONE git-op pane still on hand-written bash, and deliberately so: its
	// prelude is `github.getGitHubShellExports()` — a `gh auth token` subshell,
	// `[ -z ]`, `export`, `unset` — which lives in github.ts and is a body port of
	// its own, not a git-op one. Launching it through the dialect would hand that
	// bash text to PowerShell, which is strictly worse than a clear refusal: the
	// pane would open, print parse errors, and leave no PR opened and no verdict.
	if (launchDialectId() === "windows-powershell") {
		throw new Error("Opening a pull request from the pane is not supported on Windows yet — use the PR link in the task panel");
	}

	const { scriptPath, exitFilePath } = gitOpPaths(task.id, "openPR");
	const socket = task.tmuxSocket ?? DEFAULT_TMUX_SOCKET;
	const githubEnvExports = await github.getGitHubShellExports(project);

	const script = [
		`#!/bin/bash`,
		...githubEnvExports,
		`set -x`,
		`gh pr view --web 2>&1`,
		`EXIT_CODE=$?`,
		`set +x`,
		`echo $EXIT_CODE > "${exitFilePath}"`,
		`echo ""`,
		`if [ $EXIT_CODE -eq 0 ]; then`,
		`  printf '\\033[1;32m✓ PR opened in browser\\033[0m\\n'`,
		`  sleep 5`,
		`else`,
		`  printf '\\033[1;31m✗ Failed to open PR (exit %s)\\033[0m\\n' "$EXIT_CODE"`,
		`  echo "Press any key to close."`,
		`  read -n 1 -s`,
		`fi`,
	].join("\n") + "\n";
	await writeLaunchScript(scriptPath, script);

	const paneId = await openGitOpPane(task, task.worktreePath, scriptPath, socket);
	monitorGitPane(paneId, task, params.projectId, "openPR", socket);

	log.info("← openPullRequest (pane opened)", { paneId });
}

async function listBranches(params: { projectId: string }): Promise<Array<{ name: string; isRemote: boolean }>> {
	const project = await data.getProject(params.projectId);
	return git.listBranches(project.path);
}

async function fetchBranches(params: { projectId: string; forkRef?: string }): Promise<Array<{ name: string; isRemote: boolean }>> {
	const project = await data.getProject(params.projectId);
	if (params.forkRef) {
		const colonIdx = params.forkRef.indexOf(":");
		if (colonIdx > 0) {
			const forkOwner = params.forkRef.slice(0, colonIdx);
			const branchName = params.forkRef.slice(colonIdx + 1);
			if (forkOwner && branchName) {
				await git.fetchFork(project.path, forkOwner, branchName);
			}
		}
	} else {
		await git.fetchOrigin(project.path);
	}
	return git.listBranches(project.path);
}

const PULLABLE_BRANCHES = new Set(["main", "master"]);

// Background fetch pacing for the pull-button "behind origin" indicator.
// The renderer polls every ~15s; refreshing remote refs that often would
// reintroduce the network churn removed in PR #648, so fetch at most once
// per interval and let the cheap local rev-list pick up the result later.
const BEHIND_FETCH_INTERVAL_MS = 3 * 60_000;
const behindFetchLastAttempt = new Map<string, number>();

function maybeRefreshOriginRef(projectPath: string, branch: string): void {
	const now = Date.now();
	const last = behindFetchLastAttempt.get(projectPath) ?? 0;
	if (now - last < BEHIND_FETCH_INTERVAL_MS) return;
	behindFetchLastAttempt.set(projectPath, now);
	// Fire-and-forget: the next poll reads the updated origin/<branch> ref.
	void git.fetchOrigin(projectPath, branch).catch((err) => {
		log.debug("behind-indicator fetch failed (non-fatal)", { projectPath, branch, error: String(err) });
	});
}

async function getProjectCurrentBranch(params: { projectId: string }): Promise<{ branch: string | null; isBaseBranch: boolean; isDirty: boolean; behindOrigin: number }> {
	const project = await data.getProject(params.projectId);
	const [branch, isDirty] = await Promise.all([
		git.getCurrentBranch(project.path),
		git.isWorktreeDirty(project.path),
	]);
	const isBaseBranch = !branch || branch === project.defaultBaseBranch;

	let behindOrigin = 0;
	if (branch && PULLABLE_BRANCHES.has(branch)) {
		maybeRefreshOriginRef(project.path, branch);
		behindOrigin = await git.getBehindOriginCount(project.path, branch);
	}
	return { branch, isBaseBranch, isDirty, behindOrigin };
}

async function pullProjectMain(params: { projectId: string }): Promise<{
	ok: boolean;
	branch: string | null;
	output: string;
	error: string;
}> {
	log.info("→ pullProjectMain", params);
	const project = await data.getProject(params.projectId);
	const branch = await git.getCurrentBranch(project.path);

	if (!branch) {
		const error = "Detached HEAD — switch to a branch first";
		log.warn("pullProjectMain: detached HEAD", { projectId: params.projectId });
		return { ok: false, branch: null, output: "", error };
	}
	if (!PULLABLE_BRANCHES.has(branch)) {
		const error = `Refusing to pull on branch '${branch}' — only main or master is allowed from this button`;
		log.warn("pullProjectMain: branch not pullable", { projectId: params.projectId, branch });
		return { ok: false, branch, output: "", error };
	}

	const result = await git.pullOrigin(project.path, branch);
	log.info("← pullProjectMain", { branch, ok: result.ok });
	return {
		ok: result.ok,
		branch,
		output: result.stdout,
		error: result.stderr,
	};
}

async function getProjectPRs(params: { projectId: string }): Promise<PRInfo[]> {
	log.info("→ getProjectPRs", params);
	const project = await data.getProject(params.projectId);

	try {
		const result = await github.runGitHub(
			project,
			project.path,
			["pr", "list", "--state", "open", "--json", "number,headRefName,url", "--limit", "100"],
		);
		if (result.ok && result.stdout) {
			const prs = JSON.parse(result.stdout);
			if (Array.isArray(prs)) {
				const infos: PRInfo[] = [];
				for (const pr of prs) {
					if (typeof pr.number === "number" && typeof pr.headRefName === "string" && typeof pr.url === "string") {
						infos.push({ number: pr.number, url: pr.url, headRefName: pr.headRefName });
					}
				}
				await persistProjectPrIdentities(project, infos);
				log.info("← getProjectPRs", { count: infos.length });
				return infos;
			}
		}
	} catch (err) {
		log.warn("getProjectPRs failed (non-fatal)", { error: String(err) });
	}

	return [];
}

interface ResolvePrUrlResult {
	ok: boolean;
	branch: string | null;
	number: number | null;
	title: string | null;
	isFork: boolean;
	error: string | null;
}

// Resolve a GitHub pull-request URL to a locally-fetched branch ref, ready to be
// used as a task's `existingBranch`. Same-repo PRs resolve to `origin/<head>`;
// cross-repo (fork) PRs are fetched via the fork-remote machinery and resolve to
// `<forkOwner>/<head>` — the exact ref shapes the branch selector already accepts.
async function resolvePrUrl(params: { projectId: string; url: string }): Promise<ResolvePrUrlResult> {
	const url = params.url.trim();
	log.info("→ resolvePrUrl", { projectId: params.projectId, url });
	const project = await data.getProject(params.projectId);

	try {
		const result = await github.runGitHub(
			project,
			project.path,
			["pr", "view", url, "--json", "number,title,headRefName,headRepositoryOwner,isCrossRepository"],
			{ timeoutMs: 20_000 },
		);
		if (!result.ok || !result.stdout) {
			const error = result.stderr.trim() || "Failed to resolve pull request";
			log.warn("resolvePrUrl: gh pr view failed", { url, error });
			return { ok: false, branch: null, number: null, title: null, isFork: false, error };
		}

		const pr = JSON.parse(result.stdout) as {
			number?: number;
			title?: string;
			headRefName?: string;
			headRepositoryOwner?: { login?: string } | null;
			isCrossRepository?: boolean;
		};
		const headRefName = typeof pr.headRefName === "string" ? pr.headRefName : "";
		const number = typeof pr.number === "number" ? pr.number : null;
		const title = typeof pr.title === "string" ? pr.title : null;
		if (!headRefName) {
			return { ok: false, branch: null, number, title, isFork: false, error: "Pull request has no head branch" };
		}

		const forkOwner = pr.isCrossRepository ? pr.headRepositoryOwner?.login : undefined;
		if (forkOwner) {
			const fetched = await git.fetchFork(project.path, forkOwner, headRefName);
			if (!fetched) {
				log.warn("resolvePrUrl: fork fetch failed", { url, forkOwner, headRefName });
				return { ok: false, branch: null, number, title, isFork: true, error: `Could not fetch ${headRefName} from fork ${forkOwner}` };
			}
			log.info("← resolvePrUrl (fork)", { number, branch: `${forkOwner}/${headRefName}` });
			return { ok: true, branch: `${forkOwner}/${headRefName}`, number, title, isFork: true, error: null };
		}

		await git.fetchOrigin(project.path, headRefName);
		log.info("← resolvePrUrl (origin)", { number, branch: `origin/${headRefName}` });
		return { ok: true, branch: `origin/${headRefName}`, number, title, isFork: false, error: null };
	} catch (err) {
		log.warn("resolvePrUrl failed", { url, error: String(err) });
		return { ok: false, branch: null, number: null, title: null, isFork: false, error: String(err) };
	}
}

/**
 * "Send later" — queue a scheduled message on a task's live agent. Thin RPC
 * wrapper over the scheduler core (validation + cap + broadcast live there).
 */
async function scheduleMessage(params: {
	taskId: string;
	projectId: string;
	at: string;
	text: string;
	target: ScheduledMessageTarget;
}): Promise<Task> {
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	return scheduleMessageCore(project, task, { text: params.text, at: params.at, target: params.target });
}

/** Cancel one pending scheduled message (chip → "Cancel"). */
async function cancelScheduledMessage(params: { taskId: string; projectId: string; messageId: string }): Promise<Task> {
	const project = await data.getProject(params.projectId);
	return cancelScheduledMessageCore(project, params.taskId, params.messageId);
}

/** Deliver a pending scheduled message immediately and remove it (chip → "Send now"). */
async function sendScheduledMessageNow(params: { taskId: string; projectId: string; messageId: string }): Promise<Task> {
	const project = await data.getProject(params.projectId);
	return sendScheduledMessageNowCore(project, params.taskId, params.messageId);
}

export const gitOperationHandlers = {
	getBranchStatus,
	getUnsavedWork,
	refreshTaskPrStatus,
	getTaskDiff,
	prepareMergeCompletionPrompt,
	dismissMergeCompletionPrompt,
	rebaseTask,
	rebaseTaskViaAgent,
	commitTaskViaAgent,
	mergeTask,
	pushTask,
	createPullRequest,
	openPullRequest,
	listBranches,
	fetchBranches,
	resolvePrUrl,
	getProjectCurrentBranch,
	getProjectPRs,
	pullProjectMain,
	scheduleMessage,
	cancelScheduledMessage,
	sendScheduledMessageNow,
};
