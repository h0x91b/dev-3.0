import { useEffect, useState } from "react";
import { api } from "../rpc";
import { toast } from "../toast";
import { useT } from "../i18n";
import { mixedEntryId, type MixedEntry } from "../utils/digitOrder";

/**
 * The mixed top-level order with its writes. A reorder shows at once; the first
 * spaces push after it lands retires the stand-in, whatever the file now holds.
 */
export function useMixedOrder(entries: MixedEntry[]) {
	const t = useT();
	const [pending, setPending] = useState<string[] | null>(null);
	const waiting = pending !== null;

	useEffect(() => {
		if (!waiting) return;
		const clear = () => setPending(null);
		window.addEventListener("rpc:spacesUpdated", clear);
		return () => window.removeEventListener("rpc:spacesUpdated", clear);
	}, [waiting]);

	// The setting went off: a stale stand-in must not come back with it.
	useEffect(() => {
		if (entries.length === 0) setPending(null);
	}, [entries.length]);

	let displayed = entries;
	if (pending) {
		const rank = new Map(pending.map((id, i) => [id, i]));
		displayed = [...entries].sort(
			(a, b) => (rank.get(mixedEntryId(a)) ?? pending.length) - (rank.get(mixedEntryId(b)) ?? pending.length),
		);
	}
	const ids = displayed.map(mixedEntryId);

	async function commit(next: string[]) {
		setPending(next);
		try {
			await api.request.reorderMixedOrder({ ids: next });
		} catch (err) {
			setPending(null);
			toast.error(t("spaces.failedUpdate", { error: String(err) }));
		}
	}

	function reorder(sourceId: string, targetId: string, side: "before" | "after") {
		if (sourceId === targetId) return;
		const next = ids.filter((id) => id !== sourceId);
		const at = next.indexOf(targetId);
		if (at === -1) return;
		next.splice(side === "after" ? at + 1 : at, 0, sourceId);
		void commit(next);
	}

	function step(id: string, delta: -1 | 1) {
		const from = ids.indexOf(id);
		const to = from + delta;
		if (from === -1 || to < 0 || to >= ids.length) return;
		const next = [...ids];
		[next[from], next[to]] = [next[to], next[from]];
		void commit(next);
	}

	return { entries: displayed, reorder, step };
}
