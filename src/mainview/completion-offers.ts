import { useSyncExternalStore } from "react";
import { DEFAULT_COMPLETION_OFFER_STYLE, type CompletionOfferStyle } from "../shared/types";

/**
 * Completion offers the user has not answered yet: "the branch merged", "the
 * agent asks to complete" and the user's own Complete/Cancel on the open task.
 * The `completionOfferStyle` setting picks where merge and agent offers ask: the
 * app-level dialog (`CompletionOfferDialogHost`) or the bar on the task. The user's
 * own ask always stays on the task. Markers on the card and sidebar show in both.
 * See `decisions/2026/11/09/completion-offer-style-setting.md`.
 */
export type CompletionOfferKind = "merge" | "agent" | "user";

/** `true` completes, `false` keeps the task open, `"manual"` keeps it open and stops merge offers. */
export type CompletionOfferAnswer = boolean | "manual";

export interface CompletionOffer {
	id: string;
	taskId: string;
	projectId: string;
	kind: CompletionOfferKind;
	/** Merge offers only: the branch that landed. */
	branchName?: string;
	/** User offers only: the move the user asked for. */
	status?: "completed" | "cancelled";
	/** User offers only: what had focus when the user asked, to hand it back after. */
	returnFocus?: HTMLElement | null;
	answer: (answer: CompletionOfferAnswer) => void;
}

export interface OfferCompletionParams {
	taskId: string;
	projectId: string;
	kind: CompletionOfferKind;
	branchName?: string;
	status?: "completed" | "cancelled";
	returnFocus?: HTMLElement | null;
	/** Aborting withdraws the offer and resolves `false` (answered on another client). */
	signal?: AbortSignal;
}

let offers: CompletionOffer[] = [];
const listeners = new Set<() => void>();
let nextId = 0;
let style: CompletionOfferStyle = DEFAULT_COMPLETION_OFFER_STYLE;

function emit() {
	for (const listener of listeners) listener();
}

function remove(id: string) {
	const before = offers.length;
	offers = offers.filter((o) => o.id !== id);
	if (offers.length !== before) emit();
}

/**
 * Shows an offer on its task and resolves with the user's answer, or `null` when
 * the same kind of offer is already on that task (a forced re-check, a replay).
 */
export function offerCompletion(params: OfferCompletionParams): Promise<CompletionOfferAnswer | null> {
	return new Promise((resolve) => {
		if (params.signal?.aborted) {
			resolve(false);
			return;
		}
		if (hasCompletionOffer(params.taskId, params.kind)) {
			resolve(null);
			return;
		}
		const id = `offer-${++nextId}`;
		let settled = false;
		const settle = (answer: CompletionOfferAnswer) => {
			if (settled) return;
			settled = true;
			params.signal?.removeEventListener("abort", onAbort);
			remove(id);
			resolve(answer);
		};
		const onAbort = () => settle(false);
		params.signal?.addEventListener("abort", onAbort);
		offers = [...offers, {
			id,
			taskId: params.taskId,
			projectId: params.projectId,
			kind: params.kind,
			branchName: params.branchName,
			status: params.status,
			returnFocus: params.returnFocus,
			answer: settle,
		}];
		emit();
	});
}

/** Set by App from the global setting; every surface re-reads it, so a switch moves waiting offers. */
export function setCompletionOfferStyle(next: CompletionOfferStyle): void {
	if (next === style) return;
	style = next;
	emit();
}

export function getCompletionOfferStyle(): CompletionOfferStyle {
	return style;
}

/** Whether the offer asks in the app-level dialog rather than on its task. */
export function offerAsksInDialog(offer: Pick<CompletionOffer, "kind">, current: CompletionOfferStyle = style): boolean {
	return current === "dialog" && offer.kind !== "user";
}

export function hasCompletionOffer(taskId: string, kind: CompletionOfferKind): boolean {
	return offers.some((o) => o.taskId === taskId && o.kind === kind);
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function snapshot() {
	return offers;
}

/**
 * The offer to show for a task: the user's own click first, then an agent's
 * request, then a merge. `unsolicitedOnly` skips the user's own, for markers
 * that tell someone elsewhere that a task is waiting on them.
 */
export function pickCompletionOffer(all: readonly CompletionOffer[], taskId: string, unsolicitedOnly = false): CompletionOffer | null {
	const mine = all.filter((o) => o.taskId === taskId && !(unsolicitedOnly && o.kind === "user"));
	return mine.find((o) => o.kind === "user") ?? mine.find((o) => o.kind === "agent") ?? mine[0] ?? null;
}

export function useCompletionOffer(taskId: string, unsolicitedOnly = false): CompletionOffer | null {
	return pickCompletionOffer(useSyncExternalStore(subscribe, snapshot, snapshot), taskId, unsolicitedOnly);
}

export function useCompletionOffers(): readonly CompletionOffer[] {
	return useSyncExternalStore(subscribe, snapshot, snapshot);
}

function styleSnapshot() {
	return style;
}

export function useCompletionOfferStyle(): CompletionOfferStyle {
	return useSyncExternalStore(subscribe, styleSnapshot, styleSnapshot);
}

/** The offer the task's own strip shows: whatever is not asking in the dialog. */
export function useTaskStripOffer(taskId: string): CompletionOffer | null {
	const all = useCompletionOffers();
	const current = useCompletionOfferStyle();
	return pickCompletionOffer(all.filter((o) => !offerAsksInDialog(o, current)), taskId);
}

const mountedStrips = new Map<string, number>();
const overlayHosts = new Map<string, number>();

function counted(map: Map<string, number>, taskId: string, onChange?: () => void): () => void {
	map.set(taskId, (map.get(taskId) ?? 0) + 1);
	onChange?.();
	return () => {
		const left = (map.get(taskId) ?? 1) - 1;
		if (left > 0) map.set(taskId, left);
		else map.delete(taskId);
		onChange?.();
	};
}

/**
 * Counts the task's mounted strip hosts, so a caller can tell whether an offer is
 * actually on screen. The user's own ask lives only while its task view does.
 */
export function registerCompletionStrip(taskId: string): () => void {
	return counted(mountedStrips, taskId, () => {
		if (mountedStrips.has(taskId)) return;
		for (const offer of offers) if (offer.taskId === taskId && offer.kind === "user") offer.answer(false);
	});
}

/**
 * A live terminal viewport hosts the offer as a floating card, so the terminal
 * never resizes; the inline row under the inspector then stands down.
 */
export function registerCompletionOverlayHost(taskId: string): () => void {
	return counted(overlayHosts, taskId, emit);
}

export function useCompletionOverlayHosted(taskId: string): boolean {
	const read = () => overlayHosts.has(taskId);
	return useSyncExternalStore(subscribe, read, read);
}

/** True when a strip for this task is mounted: in immersive fullscreen it is not, even on the task. */
export function isCompletionStripMounted(taskId: string): boolean {
	return mountedStrips.has(taskId);
}

export function _resetCompletionOffersForTests(): void {
	offers = [];
	style = DEFAULT_COMPLETION_OFFER_STYLE;
	mountedStrips.clear();
	overlayHosts.clear();
	emit();
}
