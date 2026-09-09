import { useEffect, useMemo, useState } from "react";
import type { ReplayCursor } from "./task-history";
import type { TrafficRecord } from "./traffic-model";
import {
	indexAtOrAfter,
	messageAt,
	sortTimeline,
	type TrafficTimelineEvent,
} from "./traffic-timeline";

interface PlaybackState {
	scopeKey: string;
	events: TrafficTimelineEvent[] | null;
	index: number;
	playing: boolean;
	ended: boolean;
	revision: number;
}

/**
 * Walks the replay timeline — recorded task movements and messages in one union —
 * one recorded event at a time.
 *
 * It used to index `TrafficRecord[]`, which made a message the only thing that
 * could advance the cursor: an hour of board activity with nothing said had zero
 * steps. The union is what lets a task appear at its own recorded instant.
 */
export function useTrafficPlayback(
	timeline: TrafficTimelineEvent[],
	enabled: boolean,
	scopeKey: string,
) {
	const chronological = useMemo(() => sortTimeline(timeline), [timeline]);
	const [speed, updateSpeed] = useState(1);
	const intervalMs = 1100 / ((speed >= 1 ? speed * 0.75 : speed) * 0.9);
	const [state, setState] = useState<PlaybackState>({
		scopeKey,
		events: null,
		index: -1,
		playing: false,
		ended: false,
		revision: 0,
	});
	const active = enabled && state.scopeKey === scopeKey;
	const events = active && state.events ? state.events : chronological;
	const index = active ? state.index : -1;
	const playing = active && state.playing;

	useEffect(() => {
		if (!enabled || state.scopeKey !== scopeKey) {
			setState((previous) => ({
				...previous,
				scopeKey,
				events: null,
				index: -1,
				playing: false,
				ended: false,
			}));
		}
	}, [enabled, scopeKey, state.scopeKey]);

	useEffect(() => {
		if (!playing) return;
		const timer = setInterval(() => {
			setState((previous) => {
				if (!previous.playing || !previous.events) return previous;
				const next = previous.index + 1;
				if (next >= previous.events.length)
					return { ...previous, playing: false, ended: true };
				return {
					...previous,
					index: next,
					revision: previous.revision + 1,
				};
			});
		}, intervalMs);
		return () => clearInterval(timer);
	}, [playing, intervalMs, scopeKey, state.revision]);

	function activate(target: number, resume: boolean, refresh = false) {
		if (!enabled || !Number.isFinite(target)) return;
		setState((previous) => {
			const snapshot =
				!refresh && previous.scopeKey === scopeKey && previous.events
					? previous.events
					: chronological;
			if (!snapshot.length) return previous;
			const next = Math.max(
				0,
				Math.min(snapshot.length - 1, Math.trunc(target)),
			);
			return {
				scopeKey,
				events: snapshot,
				index: next,
				revision: previous.revision + 1,
				playing: resume,
				ended: false,
			};
		});
	}

	const current = index >= 0 ? (events[index] ?? null) : null;
	// One derived cursor every consumer shares, so nobody re-parses a timestamp
	// and nobody invents a different meaning for "live". `at` is a TIME, not an
	// index: card states and the visible-message cut-off select by it.
	const cursor: ReplayCursor = {
		at: current ? current.at : null,
		index,
		total: events.length,
		playing,
		kind: current ? current.kind : null,
	};
	// The surfaces that genuinely speak in messages — the flying wire, the subject
	// bubble — keep the last message at or before the cursor. A task step must
	// neither blank the wire nor light one early.
	const currentRecord: TrafficRecord | null =
		index >= 0 ? messageAt(events, index) : null;

	return {
		events,
		current,
		currentRecord,
		cursor,
		index,
		playing,
		ended: active && state.ended,
		speed,
		intervalMs,
		revision: state.revision,
		setSpeed(value: number) {
			if (Number.isFinite(value) && value > 0) updateSpeed(value);
		},
		playPause() {
			if (playing) setState((previous) => ({ ...previous, playing: false }));
			else if (index < 0 || index >= events.length - 1) activate(0, true);
			else setState((previous) => ({ ...previous, playing: enabled }));
		},
		restart() {
			activate(0, true, true);
		},
		step(delta: number) {
			activate((index < 0 ? events.length - 1 : index) + delta, false);
		},
		seek(target: number) {
			activate(target, false);
		},
		/**
		 * Land on the first event at or after `at` — the entry range ("open on the
		 * last hour"). Returns false and moves nothing when every recorded event
		 * precedes `at`, so a caller can tell "nothing happened in that window"
		 * from "started at the top".
		 */
		seekToTime(at: number, resume = false): boolean {
			if (!Number.isFinite(at)) return false;
			const target = indexAtOrAfter(events, at);
			if (target < 0) return false;
			activate(target, resume);
			return true;
		},
		live() {
			setState((previous) => ({
				...previous,
				scopeKey,
				events: null,
				index: -1,
				playing: false,
				ended: false,
			}));
		},
	};
}
