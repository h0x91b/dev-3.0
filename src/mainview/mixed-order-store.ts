import { useMemo, useSyncExternalStore } from "react";
import type { SpacesFile } from "../shared/types";
import { api } from "./rpc";
import { toast } from "./toast";
import { translate } from "./i18n";

/**
 * A spaces.json field as the user has just set it, until the host has stored it.
 * One store per field, read by every digit consumer — the dashboard, ⌘1–9 and
 * `g` + digit, the header and palette badges — so they all agree while a write is
 * in flight. Writes go one at a time and changes made meanwhile coalesce into a
 * single follow-up write of the latest value, so an older snapshot never lands
 * after a newer one.
 */
function createPendingWrite<T>(write: (value: T) => Promise<unknown>) {
	let pending: T | null = null;
	let queued: T | null = null;
	let writing = false;
	const listeners = new Set<() => void>();

	const emit = () => {
		for (const listener of listeners) listener();
	};
	const subscribe = (listener: () => void) => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	};

	async function drain(first: T): Promise<void> {
		writing = true;
		let value: T | null = first;
		try {
			while (value !== null) {
				await write(value);
				value = queued;
				queued = null;
			}
			pending = null;
		} catch (err) {
			// Back to what the host has stored; changes queued behind the failed one go too.
			queued = null;
			pending = null;
			toast.error(translate("spaces.failedUpdate", { error: String(err) }));
		} finally {
			writing = false;
			emit();
		}
	}

	return {
		usePending: (): T | null => useSyncExternalStore(subscribe, () => pending),
		commit(value: T): void {
			pending = value;
			emit();
			if (writing) queued = value;
			else void drain(value);
		},
		reset(): void {
			pending = null;
			queued = null;
			writing = false;
			listeners.clear();
		},
	};
}

const mixedOrder = createPendingWrite<string[]>((ids) => api.request.reorderMixedOrder({ ids }));
const digitSlots = createPendingWrite<(string | null)[]>((slots) => api.request.setDigitSlots({ slots }));

export const useMixedPending = mixedOrder.usePending;
/** Show `ids` at once and persist it, after any write already running. */
export const commitMixedOrder = mixedOrder.commit;

export const useDigitSlotsPending = digitSlots.usePending;
/** Show the ⌘1–9 pins at once and persist them, after any write already running. */
export const commitDigitSlots = digitSlots.commit;

/** The file with the order the user last chose laid over the stored one. */
export function withPendingMixedOrder(file: SpacesFile, order: string[] | null): SpacesFile {
	return order ? { ...file, mixedOrder: order } : file;
}

/** Both pending writes laid over the stored file — what every digit consumer reads. */
export function useDigitSpacesFile(file: SpacesFile): SpacesFile {
	const order = useMixedPending();
	const slots = useDigitSlotsPending();
	return useMemo(() => {
		const withOrder = withPendingMixedOrder(file, order);
		return slots ? { ...withOrder, digitSlots: slots } : withOrder;
	}, [file, order, slots]);
}

/** Test-only. */
export function _resetMixedOrderStore(): void {
	mixedOrder.reset();
	digitSlots.reset();
}
