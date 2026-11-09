import { api } from "../rpc";
import { confirm } from "../confirm";
import { toast } from "../toast";
import type { TFunction } from "../i18n";
import type { Project, Task, TaskDialogSubject } from "../../shared/types";
import { getTaskTitle } from "../../shared/types";
import { createMergePromptAbort } from "./mergePromptAbort";
import { buildMergeCompletionDialogOptions, runMergeCompletionPromptOnce } from "./mergeCompletionPrompt";
import { taskDialogInfo, taskDialogInfoFromSubject } from "./taskDialogInfo";

/**
 * Where the "Branch merged → complete the task?" offer originates. The App-level
 * push handler only has the wire payload (task id/title/branch plus an optional
 * {@link TaskDialogSubject} for the context card); the info-panel hook holds the
 * live `task`+`project`. The primitive accepts either and derives the title,
 * branch name and confirm info card from it — so the copy and context card have
 * a single definition regardless of caller.
 */
export type MergeCompletionContext =
	| { task: Task; project: Project }
	| { taskId: string; projectId: string; taskTitle: string; branchName: string; subject?: TaskDialogSubject };

export interface OfferMergeCompletionParams {
	context: MergeCompletionContext;
	t: TFunction;
	/** Merge-completion fingerprint for suppression + in-flight de-dup bookkeeping. */
	fingerprint: string | null | undefined;
	/**
	 * Reserve the fingerprint via `prepareMergeCompletionPrompt` before prompting,
	 * which also resolves `shouldPrompt`/`shouldNotify`. Client-discovered merges
	 * (info-panel poll / manual re-check / post-merge git-op) pass true; the App
	 * poller path passes false because the bun poller already reserved the slot
	 * server-side and shipped `shouldPrompt`/`shouldNotify` on the wire.
	 */
	reserve?: boolean;
	/**
	 * Forced re-check (user clicked the git refresh button): bypasses the backend
	 * reservation/suppression AND the in-renderer once-guard so the prompt re-opens
	 * even after a prior dismissal for the same merged head.
	 */
	force?: boolean;
	/**
	 * Poller decision for the non-reserve path (carried on the `branchMerged`
	 * wire message). Ignored when `reserve` is true — `prepare` supplies them.
	 * `shouldPrompt === false` suppresses the dialog; a `shouldNotify` alongside
	 * it downgrades to a passive toast.
	 */
	shouldPrompt?: boolean;
	shouldNotify?: boolean;
	/**
	 * Runs when the user accepts. Owns the actual completion side effect +
	 * navigation, which genuinely differs per caller (the App path has no live
	 * task object and gates navigation on the current route; the info-panel path
	 * completes the live task through `moveTaskToStatus`).
	 */
	onComplete: () => void;
	/** Opens the task subject from the dialog and intentionally follows the Not now path. */
	onOpenTask?: () => void;
}

/**
 * Outcome of a merge-completion offer. `notified` = downgraded to a passive
 * toast; `suppressed` = the reserve step declined to prompt; `manual` = the user
 * opted out of future prompts; `deduped` = an identical prompt was already in
 * flight; `aborted` = resolved on another client while open.
 */
export type OfferMergeCompletionOutcome =
	| "completed"
	| "dismissed"
	| "manual"
	| "notified"
	| "deduped"
	| "aborted"
	| "suppressed";

function resolveContext(context: MergeCompletionContext) {
	if ("task" in context) {
		const { task, project } = context;
		return {
			taskId: task.id,
			projectId: project.id,
			taskTitle: getTaskTitle(task),
			branchName: task.branchName ?? "",
			info: taskDialogInfo(task, project),
		};
	}
	return {
		taskId: context.taskId,
		projectId: context.projectId,
		taskTitle: context.taskTitle,
		branchName: context.branchName,
		info: taskDialogInfoFromSubject(context.taskTitle, context.subject),
	};
}

/**
 * The single "offer to complete a merged task" primitive shared by the App-level
 * `rpc:branchMerged` push handler and the info-panel branch-status hook. It owns
 * everything those flows used to copy-paste: the outcome-card dialog options +
 * context card, optional fingerprint reservation, the notify/suppress gate,
 * cross-client abort wiring, the once-guard de-dup, and the accept / decline /
 * manual bookkeeping. Only the completion side effect stays with the caller (via
 * `onComplete`) because it differs by surface.
 */
export async function offerMergeCompletion(
	params: OfferMergeCompletionParams,
): Promise<OfferMergeCompletionOutcome> {
	const { context, t, reserve = false, force = false, onComplete, onOpenTask } = params;
	const { taskId, projectId, taskTitle, branchName, info } = resolveContext(context);

	let fingerprint = params.fingerprint;
	let shouldPrompt = params.shouldPrompt;
	let shouldNotify = params.shouldNotify;
	if (reserve) {
		const promptState = await api.request.prepareMergeCompletionPrompt({ taskId, projectId, fingerprint, force });
		fingerprint = promptState.fingerprint;
		shouldPrompt = promptState.shouldPrompt;
		shouldNotify = promptState.shouldNotify;
	}

	// `shouldPrompt === false` (never `!shouldPrompt`): the wire path omits the
	// field on the legacy happy path, which must still prompt.
	if (shouldPrompt === false) {
		if (shouldNotify) {
			toast.info(t("app.branchMergedToast", { taskTitle }), { taskId });
			return "notified";
		}
		return "suppressed";
	}

	const abort = createMergePromptAbort(taskId);
	const runPrompt = () =>
		confirm({
			...buildMergeCompletionDialogOptions(t, branchName),
			info: onOpenTask ? { ...info, onClick: onOpenTask } : info,
			signal: abort.signal,
		});

	let choice: boolean | string | null;
	try {
		choice = force ? await runPrompt() : await runMergeCompletionPromptOnce(taskId, fingerprint, runPrompt);
	} finally {
		abort.cleanup();
	}

	// Resolved elsewhere (second window / remote browser): the dialog auto-closed.
	if (abort.signal.aborted) return "aborted";
	// Another in-renderer listener is already showing this exact prompt.
	if (choice === null) return "deduped";

	if (choice === "manual") {
		try {
			await api.request.setTaskManualCompletion({ taskId, projectId, manualCompletion: true });
		} catch (err) {
			toast.error(t("task.manualCompletionChangeFailed", { error: String(err) }), { taskId });
		}
		return "manual";
	}
	if (choice === true) {
		onComplete();
		return "completed";
	}
	// Best-effort suppression bookkeeping: a failed dismiss must not surface as
	// an unhandled rejection in the push/event listeners that call this.
	try {
		await api.request.dismissMergeCompletionPrompt({ taskId, projectId, fingerprint: fingerprint ?? null });
	} catch (err) {
		console.error("dismissMergeCompletionPrompt failed:", err);
	}
	return "dismissed";
}
