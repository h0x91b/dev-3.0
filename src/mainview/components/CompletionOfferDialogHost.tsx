import { useEffect, useRef } from "react";
import type { Project, Task } from "../../shared/types";
import { useT, type TFunction } from "../i18n";
import { api } from "../rpc";
import { confirm, whenConfirmHostMounted, type ConfirmOptions } from "../confirm";
import { keepTaskOpen, offerAsksInDialog, useCompletionOffers, useCompletionOfferStyle, type CompletionOffer } from "../completion-offers";
import { completionSkipsGitCheck, unsavedWorkWarning } from "../utils/confirmTaskCompletion";
import { taskDialogInfo } from "../utils/taskDialogInfo";
import { completionOfferNote } from "./task-info-panel/TaskCompletionStrip";

/**
 * Asks merge and agent completion offers in the shared `confirm()` modal when the
 * `completionOfferStyle` setting is "dialog". The offer stays in the store, so
 * card markers keep showing and an answer from anywhere closes the modal.
 */
export default function CompletionOfferDialogHost({ ready, projects, onOpenTask }: {
	/** False until the host's settings arrived, so a stored "inline" choice never flashes a modal. */
	ready: boolean;
	projects: Project[];
	onOpenTask: (taskId: string, projectId: string) => void;
}) {
	const t = useT();
	const offers = useCompletionOffers();
	const style = useCompletionOfferStyle();
	const asked = useRef(new Map<string, AbortController>());
	const latest = useRef({ t, projects, onOpenTask });
	latest.current = { t, projects, onOpenTask };

	useEffect(() => {
		for (const [id, controller] of asked.current) {
			if (offers.some((o) => o.id === id)) continue;
			controller.abort();
			asked.current.delete(id);
		}
		if (!ready) return;
		for (const offer of offers) {
			if (!offerAsksInDialog(offer, style) || asked.current.has(offer.id)) continue;
			const controller = new AbortController();
			asked.current.set(offer.id, controller);
			void askInDialog(offer, controller.signal, latest.current);
		}
	}, [offers, style, ready]);

	useEffect(() => () => {
		for (const controller of asked.current.values()) controller.abort();
		asked.current.clear();
	}, []);

	return null;
}

async function askInDialog(
	offer: CompletionOffer,
	signal: AbortSignal,
	{ t, projects, onOpenTask }: { t: TFunction; projects: Project[]; onOpenTask: (taskId: string, projectId: string) => void },
): Promise<void> {
	const project = projects.find((p) => p.id === offer.projectId);
	let task: Task | undefined;
	try {
		task = (await api.request.getTasks({ projectId: offer.projectId })).find((candidate) => candidate.id === offer.taskId);
	} catch (err) {
		console.error("[CompletionOfferDialogHost] getTasks failed:", err);
	}
	if (signal.aborted) return;
	if (!await whenConfirmHostMounted()) {
		console.error("[CompletionOfferDialogHost] ConfirmHost never mounted; the offer stays on its task marker");
		return;
	}
	await askOfferInModal(offer, task && project ? { task, project } : null, t, { signal, onOpenTask });
}

/**
 * Asks one merge or agent offer in the shared `confirm()` modal and hands the answer
 * to the offer: the agent-request identity, the manual-completion action for merges
 * and the gated unsaved-work check. The Ready to complete screen asks a row the same way.
 */
export async function askOfferInModal(
	offer: CompletionOffer,
	known: { task: Task; project: Project } | null,
	t: TFunction,
	{ signal, onOpenTask }: { signal?: AbortSignal; onOpenTask?: (taskId: string, projectId: string) => void } = {},
): Promise<void> {
	const isAgent = offer.kind === "agent";
	const skipGit = known ? completionSkipsGitCheck(known.task, known.project) : false;
	const openTask = !isAgent && onOpenTask ? () => onOpenTask(offer.taskId, offer.projectId) : undefined;
	const options: ConfirmOptions = {
		title: t(isAgent ? "completionStrip.agentTitle" : "completionStrip.mergedTitle"),
		message: known ? completionOfferNote(known.task, known.project, t) : t("completionStrip.worktreeNote"),
		// Opening the task answers "Keep open": right for a merge, a refusal for the agent.
		info: known ? taskDialogInfo(known.task, known.project, openTask) : undefined,
		confirmLabel: t("app.branchMergedComplete"),
		cancelLabel: t("completionStrip.keepOpen"),
		danger: true,
		agentInitiated: isAgent,
		dismissOnBackdrop: false,
		alternativeAction: offer.kind === "merge" ? { label: t("app.branchMergedManualCompletion"), value: "manual" } : undefined,
		deferred: skipGit ? undefined : {
			pending: t("task.checkingBranchState"),
			unknown: t("task.branchStateUnknown"),
			gateConfirm: true,
			promise: api.request.getUnsavedWork({ taskId: offer.taskId, projectId: offer.projectId }).then((status) => unsavedWorkWarning(status, t)),
		},
		signal,
	};
	const { alternativeAction } = options;
	const result = alternativeAction ? await confirm({ ...options, alternativeAction }) : await confirm(options);
	if (signal?.aborted) return;
	if (result === false) keepTaskOpen(offer.taskId);
	else offer.answer(result === "manual" ? "manual" : true);
}
