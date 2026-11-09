import { useSyncExternalStore } from "react";

/**
 * Completion offers the user has not answered yet: "the branch merged" and "the
 * agent asks to complete". They render inline on the task (strip in the task view,
 * marker on its card) instead of a modal, so an offer never blocks the board.
 * See `decisions/2026/11/07/completion-offers-render-inline-not-modal.md`.
 */
export type CompletionOfferKind = "merge" | "agent";

/** `true` completes, `false` keeps the task open, `"manual"` keeps it open and stops merge offers. */
export type CompletionOfferAnswer = boolean | "manual";

export interface CompletionOffer {
	id: string;
	taskId: string;
	projectId: string;
	kind: CompletionOfferKind;
	/** Merge offers only: the branch that landed. */
	branchName?: string;
	answer: (answer: CompletionOfferAnswer) => void;
}

export interface OfferCompletionParams {
	taskId: string;
	projectId: string;
	kind: CompletionOfferKind;
	branchName?: string;
	/** Aborting withdraws the offer and resolves `false` (answered on another client). */
	signal?: AbortSignal;
}

let offers: CompletionOffer[] = [];
const listeners = new Set<() => void>();
let nextId = 0;

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
			answer: settle,
		}];
		emit();
	});
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

/** The offer to show for a task. An agent's own request outranks a merge offer. */
export function pickCompletionOffer(all: readonly CompletionOffer[], taskId: string): CompletionOffer | null {
	const mine = all.filter((o) => o.taskId === taskId);
	return mine.find((o) => o.kind === "agent") ?? mine[0] ?? null;
}

export function useCompletionOffer(taskId: string): CompletionOffer | null {
	return pickCompletionOffer(useSyncExternalStore(subscribe, snapshot, snapshot), taskId);
}

export function useCompletionOffers(): readonly CompletionOffer[] {
	return useSyncExternalStore(subscribe, snapshot, snapshot);
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

/** Counts the task's mounted strip hosts, so a caller can tell whether an offer is actually on screen. */
export function registerCompletionStrip(taskId: string): () => void {
	return counted(mountedStrips, taskId);
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
	mountedStrips.clear();
	overlayHosts.clear();
	emit();
}
