import { useEffect, useRef } from "react";
import type { Project, Task } from "../../shared/types";
import { useT, type TFunction } from "../i18n";
import { api } from "../rpc";
import { confirm, whenConfirmHostMounted, type ConfirmAlternativeAction, type ConfirmOptions } from "../confirm";
import { keepTaskOpen, offerAsksInDialog, useCompletionOffers, useCompletionOfferStyle, type CompletionOffer } from "../completion-offers";
import { buildMergeCompletionDialogOptions } from "../utils/mergeCompletionPrompt";
import { completionSkipsGitCheck, unsavedWorkWarning } from "../utils/confirmTaskCompletion";
import { taskDialogInfo } from "../utils/taskDialogInfo";
import { completionOfferNote } from "./task-info-panel/TaskCompletionStrip";

/**
 * Asks merge and agent completion offers in the shared `confirm()` modal when the
 * `completionOfferStyle` setting is "dialog", with the same dialogs as before the
 * setting existed. The offer stays in the store, so an answer from anywhere closes the modal.
 */
export default function CompletionOfferDialogHost({ ready }: {
	/** False until the host's settings arrived, so a stored "inline" choice never flashes a modal. */
	ready: boolean;
}) {
	const t = useT();
	const offers = useCompletionOffers();
	const style = useCompletionOfferStyle();
	const asked = useRef(new Map<string, AbortController>());
	const latestT = useRef(t);
	latestT.current = t;

	useEffect(() => {
		// A modal closes when its offer settled or no longer asks in the dialog (a switch
		// to On the task): the offer stays in the store and its bar takes over.
		for (const [id, controller] of asked.current) {
			const offer = offers.find((o) => o.id === id);
			if (offer && offerAsksInDialog(offer, style)) continue;
			controller.abort();
			asked.current.delete(id);
		}
		if (!ready) return;
		for (const offer of offers) {
			if (!offerAsksInDialog(offer, style) || asked.current.has(offer.id)) continue;
			const controller = new AbortController();
			asked.current.set(offer.id, controller);
			void askInDialog(offer, controller.signal, latestT.current);
		}
	}, [offers, style, ready]);

	useEffect(() => () => {
		for (const controller of asked.current.values()) controller.abort();
		asked.current.clear();
	}, []);

	return null;
}

/** The dialogs these asks opened before the setting existed, so the default style behaves exactly as it did. */
function dialogOptions(offer: CompletionOffer, t: TFunction, signal: AbortSignal): ConfirmOptions & { alternativeAction?: ConfirmAlternativeAction } {
	if (offer.kind === "merge") {
		return { ...buildMergeCompletionDialogOptions(t, offer.branchName ?? ""), info: offer.dialogInfo, signal };
	}
	return {
		title: t("app.agentCompletionTitle"),
		message: t(offer.keepsFolder ? "app.agentCompletionMessageFolder" : "app.agentCompletionMessage"),
		info: offer.dialogInfo,
		...(offer.reason ? { reason: offer.reason } : {}),
		confirmLabel: t("app.agentCompletionConfirm"),
		cancelLabel: t("app.agentCompletionCancel"),
		danger: true,
		agentInitiated: true,
		signal,
	};
}

async function askInDialog(offer: CompletionOffer, signal: AbortSignal, t: TFunction): Promise<void> {
	if (!await whenConfirmHostMounted()) {
		console.error("[CompletionOfferDialogHost] ConfirmHost never mounted; the offer stays pending");
		return;
	}
	if (signal.aborted) return;
	const options = dialogOptions(offer, t, signal);
	const { alternativeAction } = options;
	const result = alternativeAction ? await confirm({ ...options, alternativeAction }) : await confirm(options);
	if (signal.aborted) return;
	offer.answer(result === "manual" ? "manual" : result === true);
}

/**
 * Asks one Ready to complete row in the shared `confirm()` modal and hands the answer
 * to the offer: the agent-request identity, the manual-completion action for merges
 * and the gated unsaved-work check, as the bar asks it.
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
		...(offer.reason ? { reason: offer.reason } : {}),
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
