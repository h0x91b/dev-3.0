import { useEffect, useRef } from "react";
import { useT, type TFunction } from "../i18n";
import { confirm, whenConfirmHostMounted, type ConfirmAlternativeAction, type ConfirmOptions } from "../confirm";
import { offerAsksInDialog, useCompletionOffers, useCompletionOfferStyle, type CompletionOffer } from "../completion-offers";
import { buildMergeCompletionDialogOptions } from "../utils/mergeCompletionPrompt";
import { unsavedWorkWarning } from "../utils/confirmTaskCompletion";
import { api } from "../rpc";

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
	const check = offer.attachedWorktree;
	return {
		title: t("app.agentCompletionTitle"),
		message: t(offer.keepsFolder ? "app.agentCompletionMessageFolder" : "app.agentCompletionMessage")
			+ (check ? `\n\n${t("task.attachedWorktreeNote")}` : ""),
		info: offer.dialogInfo,
		...(offer.reason ? { reason: offer.reason } : {}),
		confirmLabel: t("app.agentCompletionConfirm"),
		cancelLabel: t("app.agentCompletionCancel"),
		danger: true,
		agentInitiated: true,
		deferred: check
			? {
				pending: t("task.checkingBranchState"),
				unknown: t("task.branchStateUnknown"),
				gateConfirm: true,
				promise: api.request.getUnsavedWork({ taskId: offer.taskId, projectId: offer.projectId, expectedAttachedRepo: check.repo }).then((status) => {
					check.onChecked(check.repo);
					return unsavedWorkWarning(status, t);
				}),
			}
			: undefined,
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
