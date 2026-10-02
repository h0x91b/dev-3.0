import { useCallback, useEffect, useRef, useState } from "react";
import type { TmuxWindowEntry } from "../../shared/types";
import { api } from "../rpc";
import { subscribeTmuxWindowsChanged } from "../terminal-window-nav";

// Windows open, close and rename outside React (⌃B c, an agent, a script), and
// tmux pushes nothing, so the list is polled — one list-windows per visible task.
const WINDOW_POLL_MS = 3000;

export interface TmuxWindowsState {
	/** Home window first, then tmux order. */
	windows: TmuxWindowEntry[];
	active: TmuxWindowEntry | null;
	home: TmuxWindowEntry | null;
	/** Background windows that printed something since the user last looked at them. */
	unseen: ReadonlySet<string>;
	/** The latest window that appeared on its own — for a polite screen-reader announcement. */
	arrived: TmuxWindowEntry | null;
	navigate: (opts: { step?: "next" | "prev"; windowId?: string }) => Promise<void>;
}

export function orderWindows(windows: readonly TmuxWindowEntry[]): TmuxWindowEntry[] {
	const home = windows.filter((w) => w.home);
	return [...home, ...windows.filter((w) => !w.home)];
}

export function useTmuxWindows(taskId: string, enabled = true): TmuxWindowsState {
	const [windows, setWindows] = useState<TmuxWindowEntry[]>([]);
	const [unseen, setUnseen] = useState<ReadonlySet<string>>(new Set());
	const [arrived, setArrived] = useState<TmuxWindowEntry | null>(null);
	const seenActivityRef = useRef(new Map<string, number>());
	const knownIdsRef = useRef<Set<string> | null>(null);
	const busyRef = useRef(false);
	const seqRef = useRef(0);

	const apply = useCallback((next: TmuxWindowEntry[]) => {
		const seen = seenActivityRef.current;
		const known = knownIdsRef.current;
		let newcomer: TmuxWindowEntry | null = null;
		for (const w of next) {
			// A window counts as "seen" up to its activity while it is active, and on
			// first sight — the arrival itself is the news, not its first prompt.
			if (w.active || !seen.has(w.windowId)) seen.set(w.windowId, w.activity);
			if (known && !known.has(w.windowId)) newcomer = w;
		}
		const ids = new Set(next.map((w) => w.windowId));
		for (const id of [...seen.keys()]) if (!ids.has(id)) seen.delete(id);
		knownIdsRef.current = ids;
		// The agent's own window repaints constantly (spinners, timers, a redraw on
		// every resize), so "printed since you looked" would be permanent noise there.
		setUnseen(new Set(next.filter((w) => !w.active && !w.home && w.activity > (seen.get(w.windowId) ?? 0)).map((w) => w.windowId)));
		if (newcomer) setArrived(newcomer);
		setWindows(orderWindows(next));
	}, []);

	const request = useCallback(
		async (opts?: { step?: "next" | "prev"; windowId?: string }) => {
			const moves = !!(opts?.step || opts?.windowId);
			// A poll never stacks on another poll; a click always goes through.
			if (busyRef.current && !moves) return;
			busyRef.current = true;
			const seq = ++seqRef.current;
			try {
				const res = await api.request.tmuxWindowNavigate({ taskId, ...opts });
				// A poll that started before a click must not paint the pre-click state.
				if (seq === seqRef.current) apply(res.windows);
			} catch {
				// A gone session or a dropped RPC: keep the last known list until the next poll.
			} finally {
				if (seq === seqRef.current) busyRef.current = false;
			}
		},
		[taskId, apply],
	);

	useEffect(() => {
		knownIdsRef.current = null;
		seenActivityRef.current.clear();
		setWindows([]);
		setArrived(null);
	}, [taskId]);

	useEffect(() => {
		if (!enabled) return;
		const read = () => {
			if (typeof document === "undefined" || document.visibilityState !== "hidden") void request();
		};
		read();
		const id = setInterval(read, WINDOW_POLL_MS);
		const unsubscribe = subscribeTmuxWindowsChanged(taskId, read);
		return () => {
			clearInterval(id);
			unsubscribe();
		};
	}, [taskId, enabled, request]);

	return {
		windows,
		active: windows.find((w) => w.active) ?? null,
		home: windows.find((w) => w.home) ?? null,
		unseen,
		arrived,
		navigate: request,
	};
}
