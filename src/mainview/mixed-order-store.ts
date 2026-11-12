import { useSyncExternalStore } from "react";
import type { SpacesFile } from "../shared/types";
import { api } from "./rpc";
import { toast } from "./toast";
import { translate } from "./i18n";

/**
 * The mixed top-level order as the user has just arranged it, until the host has
 * stored it. One module for every reader — the dashboard, ⌘1–9 and `g` + digit,
 * the header and palette badges — so they all show the same digits while a write
 * is in flight. Writes go one at a time and moves made meanwhile coalesce into a
 * single follow-up write of the latest order, so an older snapshot can never land
 * after a newer one.
 */
let pending: string[] | null = null;
let queued: string[] | null = null;
let writing = false;
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function useMixedPending(): string[] | null {
	return useSyncExternalStore(subscribe, () => pending);
}

/** The file with the order the user last chose laid over the stored one. */
export function withPendingMixedOrder(file: SpacesFile, order: string[] | null): SpacesFile {
	return order ? { ...file, mixedOrder: order } : file;
}

async function drain(first: string[]): Promise<void> {
	writing = true;
	let ids: string[] | null = first;
	try {
		while (ids) {
			await api.request.reorderMixedOrder({ ids });
			ids = queued;
			queued = null;
		}
		pending = null;
	} catch (err) {
		// Back to what the host has stored; moves queued behind the failed one go too.
		queued = null;
		pending = null;
		toast.error(translate("spaces.failedUpdate", { error: String(err) }));
	} finally {
		writing = false;
		emit();
	}
}

/** Show `ids` at once and persist it, after any write already running. */
export function commitMixedOrder(ids: string[]): void {
	pending = ids;
	emit();
	if (writing) queued = ids;
	else void drain(ids);
}

/** Test-only. */
export function _resetMixedOrderStore(): void {
	pending = null;
	queued = null;
	writing = false;
	listeners.clear();
}
