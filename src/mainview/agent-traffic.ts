/**
 * The renderer's view of one project's agent-to-agent traffic.
 *
 * The durable half already exists: every `dev3 message` attempt is appended to
 * `~/.dev3.0/data/<slug>/messages/YYYY-MM-DD.jsonl` and read back through the
 * `readAgentMessageLog` RPC (30 days, newest first). Until now nothing in the UI
 * opened it — the only trace a human saw was a 30-second toast. This module is
 * the read model that the header readout and the traffic log share, so the two
 * can never disagree about who is talking to whom.
 *
 * Rows are the on-disk rows, unchanged. Everything this module adds is derived:
 * pairs, direction, and who owes an answer. No new field is invented, and in
 * particular there is no importance axis — a sender has no way to say "this one
 * matters", so the log never pretends one message outranks another. The one real
 * axis is the delivery verdict the row already carries.
 */

import type { AgentMessageLogPage, AgentMessageLogRow } from "../shared/agent-message-log";
import type { AgentPromptDeliveryStatus } from "../shared/agent-prompt-delivery";
import { api } from "./rpc";

/**
 * How recent a pair's newest message must be for the header to call it live.
 *
 * The glyph answers "are my agents talking right now", so it has to forget: a
 * pair that went quiet before lunch is history, and history is what the log is
 * for. The log itself never filters by this.
 */
export const LIVE_WINDOW_MS = 60 * 60 * 1000;

/** A message whose text never provably reached the receiver's pane. */
export function isUnsettled(status: AgentPromptDeliveryStatus): boolean {
	return status === "unconfirmed" || status === "not-delivered";
}

/** Two tasks and the state their messages add up to. */
export interface TrafficPair {
	/** Stable key: the two task ids, ordered, so direction cannot split a pair. */
	key: string;
	/** Sender of the NEWEST message — the one that does not owe an answer. */
	fromSeq: number | null;
	fromTitle?: string;
	/** Receiver of the newest message: whoever owes the next word. */
	toSeq: number;
	toTitle?: string;
	toTaskId: string;
	toProjectId: string;
	count: number;
	/** The newest row, verbatim. */
	last: AgentMessageLogRow;
	/** Epoch ms of the newest row; `0` when its timestamp is unparseable. */
	lastAt: number;
	/** True while any row of the pair has no proof of delivery. */
	unsettled: boolean;
}

export interface TrafficState {
	rows: AgentMessageLogRow[];
	/** Oldest day still on disk, `YYYY-MM-DD`, or null when there is no history. */
	oldestDay: string | null;
	retentionDays: number;
	/** True when the page was cut short and older rows exist on disk. */
	hasMore: boolean;
	loading: boolean;
	loaded: boolean;
}

const EMPTY: TrafficState = {
	rows: [],
	oldestDay: null,
	retentionDays: 30,
	hasMore: false,
	loading: false,
	loaded: false,
};

function rowTime(row: AgentMessageLogRow): number {
	const at = Date.parse(row.at);
	return Number.isNaN(at) ? 0 : at;
}

function pairKey(row: AgentMessageLogRow): string {
	const from = row.fromTaskId ?? `seq:${row.fromSeq ?? "?"}`;
	return [from, row.toTaskId].sort().join("|");
}

/**
 * Fold rows into pairs, newest pair first.
 *
 * "Who waits on whom" needs no new data: whoever received the newest message is
 * the one that has not answered yet. That is the whole derivation, and it is why
 * the pair keeps the newest row rather than a summary of it.
 */
export function derivePairs(rows: AgentMessageLogRow[]): TrafficPair[] {
	const byKey = new Map<string, TrafficPair>();
	for (const row of rows) {
		// A row with no sender is a hand-off from dev3 itself, not agent traffic.
		if (row.fromSeq === null && row.fromTaskId === null) continue;
		const key = pairKey(row);
		const at = rowTime(row);
		const existing = byKey.get(key);
		if (!existing) {
			byKey.set(key, {
				key,
				fromSeq: row.fromSeq,
				fromTitle: row.fromTitle,
				toSeq: row.toSeq,
				toTitle: row.toTitle,
				toTaskId: row.toTaskId,
				toProjectId: row.toProjectId,
				count: 1,
				last: row,
				lastAt: at,
				unsettled: isUnsettled(row.status),
			});
			continue;
		}
		existing.count += 1;
		existing.unsettled = existing.unsettled || isUnsettled(row.status);
		if (at > existing.lastAt) {
			existing.fromSeq = row.fromSeq;
			existing.fromTitle = row.fromTitle;
			existing.toSeq = row.toSeq;
			existing.toTitle = row.toTitle;
			existing.toTaskId = row.toTaskId;
			existing.toProjectId = row.toProjectId;
			existing.last = row;
			existing.lastAt = at;
		}
	}
	return [...byKey.values()].sort((a, b) => b.lastAt - a.lastAt);
}

/** The pairs the header speaks for: talking inside {@link LIVE_WINDOW_MS}. */
export function livePairs(pairs: TrafficPair[], now = Date.now()): TrafficPair[] {
	return pairs.filter((pair) => now - pair.lastAt <= LIVE_WINDOW_MS);
}

/* ── store ──────────────────────────────────────────────────────────────── */

const states = new Map<string, TrafficState>();
const listeners = new Set<(projectId: string) => void>();
const refetchTimers = new Map<string, ReturnType<typeof setTimeout>[]>();

/**
 * A live arrival refetches instead of being inserted from the push payload.
 *
 * The push carries only a clamped one-line preview, while the row on disk holds
 * the full body and the delivery verdict — inserting the preview would put a
 * shorter, statusless copy of the same message in the log. The refetch is
 * debounced because a burst of messages is one write per message, and it runs a
 * second time because the row is appended at the delivery OUTCOME while the push
 * fires as the text goes in: the first read can legitimately miss it.
 */
const REFETCH_DEBOUNCE_MS = 400;
const REFETCH_SETTLE_MS = 2_500;

export function getTrafficState(projectId: string | null | undefined): TrafficState {
	if (!projectId) return EMPTY;
	return states.get(projectId) ?? EMPTY;
}

export function subscribeTraffic(listener: (projectId: string) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function emit(projectId: string): void {
	for (const listener of listeners) listener(projectId);
}

function patch(projectId: string, next: Partial<TrafficState>): void {
	states.set(projectId, { ...getTrafficState(projectId), ...next });
	emit(projectId);
}

export async function loadTraffic(projectId: string, limit = 500): Promise<void> {
	if (!projectId) return;
	patch(projectId, { loading: true });
	try {
		const page: AgentMessageLogPage = await api.request.readAgentMessageLog({ projectId, limit });
		patch(projectId, {
			rows: page.rows,
			oldestDay: page.oldestDay,
			retentionDays: page.retentionDays,
			hasMore: page.hasMore,
			loading: false,
			loaded: true,
		});
	} catch {
		// A project with no traffic answers with an empty page, so a throw here is a
		// transport failure: keep whatever was already shown rather than blanking it.
		patch(projectId, { loading: false, loaded: true });
	}
}

/** Called when a message lands for this project (`rpc:agentMessage`). */
export function noteTrafficArrival(projectId: string): void {
	if (!projectId) return;
	for (const timer of refetchTimers.get(projectId) ?? []) clearTimeout(timer);
	refetchTimers.set(projectId, [
		setTimeout(() => void loadTraffic(projectId), REFETCH_DEBOUNCE_MS),
		setTimeout(() => void loadTraffic(projectId), REFETCH_SETTLE_MS),
	]);
}

/** Test seam: drop every cached page, listener and pending refetch. */
export function resetTrafficStore(): void {
	for (const timers of refetchTimers.values()) for (const timer of timers) clearTimeout(timer);
	refetchTimers.clear();
	states.clear();
	listeners.clear();
}
