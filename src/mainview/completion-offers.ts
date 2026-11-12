import { useSyncExternalStore } from "react";
import { DEFAULT_COMPLETION_OFFER_STYLE, type CompletionOfferStyle } from "../shared/types";
import type { ApprovalReason } from "../shared/approval-reason";

/**
 * Completion offers the user has not answered yet: "the branch merged" and "the
 * agent asks to complete". The `completionOfferStyle` setting picks where they ask:
 * the app-level dialog (`CompletionOfferDialogHost`) or the bar on the task.
 * Markers on the card and sidebar show in both. The user's own Complete/Cancel is
 * not an offer: it asks through `confirmTaskCompletion`.
 * See `decisions/2026/11/09/completion-offer-style-setting.md`.
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
	/** Agent offers only: why the agent asks (`--reason`). */
	reason?: ApprovalReason;
	/** Set when the style switched to Dialog while this offer waited: it keeps asking on its task. */
	staysOnTask?: boolean;
	/** When this client raised it (epoch ms), so a waiting list can show how long it has waited. */
	offeredAt: number;
	answer: (answer: CompletionOfferAnswer) => void;
}

export interface OfferCompletionParams {
	taskId: string;
	projectId: string;
	kind: CompletionOfferKind;
	branchName?: string;
	reason?: ApprovalReason;
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
			...(params.reason ? { reason: params.reason } : {}),
			offeredAt: Date.now(),
			answer: settle,
		}];
		emit();
	});
}

/**
 * Set by App from the global setting. A switch to Dialog applies to new offers:
 * the ones already waiting on their tasks stay there instead of opening a modal
 * each, which the user could only leave by answering or refusing every agent.
 */
export function setCompletionOfferStyle(next: CompletionOfferStyle): void {
	if (next === style) return;
	if (next === "dialog") offers = offers.map((o) => ({ ...o, staysOnTask: true }));
	style = next;
	emit();
}

export function getCompletionOfferStyle(): CompletionOfferStyle {
	return style;
}

/** Whether the offer asks in the app-level dialog rather than on its task. */
export function offerAsksInDialog(offer: Pick<CompletionOffer, "staysOnTask">, current: CompletionOfferStyle = style): boolean {
	return current === "dialog" && !offer.staysOnTask;
}

/**
 * "Keep open" means the task is not done, whichever offer asked: it says no to
 * the agent and dismisses the merge offer too, so a second bar never takes the
 * first one's place under the pointer.
 */
export function keepTaskOpen(taskId: string): void {
	for (const offer of offers.filter((o) => o.taskId === taskId)) offer.answer(false);
}

/** Aborts once the offer is answered or withdrawn anywhere, so a modal asking it can close. */
export function offerSettledSignal(offerId: string): AbortSignal {
	const controller = new AbortController();
	const check = () => {
		if (offers.some((o) => o.id === offerId)) return;
		listeners.delete(check);
		controller.abort();
	};
	listeners.add(check);
	check();
	return controller.signal;
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

/** The offer to show for a task: an agent's request before a merge. */
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

function styleSnapshot() {
	return style;
}

export function useCompletionOfferStyle(): CompletionOfferStyle {
	return useSyncExternalStore(subscribe, styleSnapshot, styleSnapshot);
}

/** The offer the task's own strip shows, or null while it asks in the dialog. */
export function useTaskStripOffer(taskId: string): CompletionOffer | null {
	const offer = useCompletionOffer(taskId);
	const current = useCompletionOfferStyle();
	return offer && !offerAsksInDialog(offer, current) ? offer : null;
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
 * A live terminal viewport hosts the offer as a floating bar, so the terminal
 * never resizes; the inline row under the inspector then stands down.
 */
export function registerCompletionOverlayHost(taskId: string): () => void {
	return counted(overlayHosts, taskId, emit);
}

export function useCompletionOverlayHosted(taskId: string): boolean {
	const read = () => overlayHosts.has(taskId);
	return useSyncExternalStore(subscribe, read, read);
}

const waitingLists = new Set<symbol>();

/** Tracks mounted surfaces that already show every waiting ask: the Ready to complete screen and its dashboard card. */
export function registerWaitingOffersList(): () => void {
	const token = Symbol("waiting-offers-list");
	waitingLists.add(token);
	return () => { waitingLists.delete(token); };
}

/**
 * Whether an ask on this task is already on screen, so no toast needs to tell about
 * it: its task's strip is mounted (not in immersive fullscreen), or the list is.
 */
export function isCompletionOfferOnScreen(taskId: string): boolean {
	return mountedStrips.has(taskId) || waitingLists.size > 0;
}

export function _resetCompletionOffersForTests(): void {
	offers = [];
	style = DEFAULT_COMPLETION_OFFER_STYLE;
	waitingLists.clear();
	mountedStrips.clear();
	overlayHosts.clear();
	emit();
}
