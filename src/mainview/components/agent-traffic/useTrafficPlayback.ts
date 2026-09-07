import { useEffect, useMemo, useState } from "react";
import type { TrafficRecord } from "./traffic-model";

interface PlaybackState {
	scopeKey: string;
	events: TrafficRecord[] | null;
	index: number;
	playing: boolean;
	ended: boolean;
	revision: number;
}

export function useTrafficPlayback(
	records: TrafficRecord[],
	enabled: boolean,
	scopeKey: string,
) {
	const chronological = useMemo(
		() =>
			[...records]
				.reverse()
				.sort((a, b) => Date.parse(a.row.at) - Date.parse(b.row.at)),
		[records],
	);
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

	return {
		events,
		current: index >= 0 ? (events[index] ?? null) : null,
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
