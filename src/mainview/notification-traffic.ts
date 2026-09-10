/**
 * Renderer-side store for the global `dev3 notify` archive.
 *
 * One global state rather than the message log's per-project map, because the
 * archive itself is global: a notification sent from a plain shell has no project
 * to file it under. Narrowing to the projects the user can see is a parameter of
 * the read (so a sensitive project's text never reaches the renderer at all), not
 * a shape of the store.
 */

import type { NotificationLogPage, NotificationLogRow } from "../shared/notification-log";
import { api } from "./rpc";

export interface NotificationTrafficState {
	/** Newest first, exactly as the reader returned them. */
	rows: NotificationLogRow[];
	/** Oldest day on disk, `YYYY-MM-DD`, or null when the archive is empty. */
	oldestDay: string | null;
	/** Newest day on disk. Null with `oldestDay` means collection never started here. */
	newestDay: string | null;
	retentionDays: number;
	/** True when the page was cut short and older rows exist on disk. */
	hasMore: boolean;
	loading: boolean;
	loaded: boolean;
	error?: boolean;
}

const EMPTY: NotificationTrafficState = {
	rows: [],
	oldestDay: null,
	newestDay: null,
	retentionDays: 30,
	hasMore: false,
	loading: false,
	loaded: false,
};

let state: NotificationTrafficState = EMPTY;
const listeners = new Set<() => void>();

/** Coalesce a burst of appends into one read, the same 100ms the message log uses. */
const REFETCH_DEBOUNCE_MS = 100;
let refetchTimer: ReturnType<typeof setTimeout> | null = null;
let lastQuery: { limit: number; projectIds: string[] | null } = { limit: 500, projectIds: null };
let loadVersion = 0;

export function getNotificationTrafficState(): NotificationTrafficState {
	return state;
}

export function subscribeNotificationTraffic(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function patch(next: Partial<NotificationTrafficState>): void {
	state = { ...state, ...next };
	for (const listener of listeners) listener();
}

export async function loadNotificationTraffic(query: { limit?: number; projectIds?: string[] | null } = {}): Promise<void> {
	const limit = query.limit ?? lastQuery.limit;
	const projectIds = query.projectIds === undefined ? lastQuery.projectIds : query.projectIds;
	lastQuery = { limit, projectIds };
	const version = ++loadVersion;
	patch({ loading: true, error: false });
	try {
		const page: NotificationLogPage = await api.request.readNotificationLog({
			limit,
			...(projectIds ? { projectIds } : {}),
		});
		// A later load already answered; this reply is stale, not wrong.
		if (loadVersion !== version) return;
		patch({
			rows: page.rows,
			oldestDay: page.oldestDay,
			newestDay: page.newestDay,
			retentionDays: page.retentionDays,
			hasMore: page.hasMore,
			loading: false,
			loaded: true,
		});
	} catch {
		// An empty archive answers with an empty page, so a throw is a transport
		// failure: keep whatever was already shown rather than blanking it.
		if (loadVersion !== version) return;
		patch({ loading: false, loaded: true, error: true });
	}
}

/** Called on `notificationLogChanged`. Re-reads with the last query, debounced. */
export function noteNotificationArrival(): void {
	if (refetchTimer) clearTimeout(refetchTimer);
	refetchTimer = setTimeout(() => {
		refetchTimer = null;
		void loadNotificationTraffic();
	}, REFETCH_DEBOUNCE_MS);
}

/** Test seam: drop the cached page, every listener and any pending refetch. */
export function resetNotificationTrafficStore(): void {
	if (refetchTimer) clearTimeout(refetchTimer);
	refetchTimer = null;
	state = EMPTY;
	lastQuery = { limit: 500, projectIds: null };
	// Bumped, never reset to 0: a read still in flight across the reset would
	// otherwise match the version of the NEXT read and patch the fresh store with
	// the page it was asked for before the reset.
	loadVersion++;
	listeners.clear();
}
