import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../shared/types";
import type { TrafficRecord } from "../components/agent-traffic/traffic-model";
import {
	messageEvents,
	taskEvents,
	type TrafficTimelineEvent,
} from "../components/agent-traffic/traffic-timeline";
import { useTrafficPlayback } from "../components/agent-traffic/useTrafficPlayback";

/** Seconds past 10:00, as an ISO instant — fractions land between two messages. */
function at(second: number): string {
	return new Date(Date.UTC(2026, 8, 7, 10, 0, 0) + second * 1000).toISOString();
}

function record(key: string, second: number): TrafficRecord {
	return {
		key,
		row: {
			v: 1,
			at: new Date(Date.UTC(2026, 8, 7, 10, 0, second)).toISOString(),
			fromTaskId: "sender",
			fromSeq: 1,
			toTaskId: "receiver",
			toSeq: 2,
			toProjectId: "project",
			kind: "immediate",
			body: key,
			bodyKind: "text",
			status: "delivered",
		},
	};
}

const first = record("first", 1);
const second = record("second", 2);
const third = record("third", 3);
const records = [third, second, first];
const defaultInterval = 1629;
// The hook walks a timeline union now, so the fixtures are wrapped once here.
// `currentRecord` unwraps back to the very same record object, which is what the
// identity assertions below rely on.
const baseEvents = messageEvents(records);

function setup(initial = { events: baseEvents, enabled: true, scopeKey: "project" }) {
	return renderHook(
		(props) => useTrafficPlayback(props.events, props.enabled, props.scopeKey),
		{ initialProps: initial },
	);
}

describe("traffic playback", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("starts in live mode with chronological events without mutating the log", () => {
		const { result } = setup();
		expect(result.current.events.flatMap((event) => (event.kind === "message" ? [event.record] : []))).toEqual([first, second, third]);
		expect(records).toEqual([third, second, first]);
		expect(result.current.index).toBe(-1);
		expect(result.current.currentRecord).toBeNull();
		expect(result.current.playing).toBe(false);
		expect(result.current.speed).toBe(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("activates immediately, advances at the selected pace, and stays at the end", () => {
		const { result } = setup();
		act(() => result.current.playPause());
		expect(result.current.currentRecord).toBe(first);
		expect(result.current.revision).toBe(1);
		act(() => vi.advanceTimersByTime(defaultInterval - 1));
		expect(result.current.currentRecord).toBe(first);
		act(() => vi.advanceTimersByTime(1));
		expect(result.current.currentRecord).toBe(second);
		act(() => vi.advanceTimersByTime(defaultInterval));
		expect(result.current.currentRecord).toBe(third);
		expect(result.current.revision).toBe(3);
		expect(result.current.playing).toBe(true);
		act(() => vi.advanceTimersByTime(defaultInterval - 1));
		expect(result.current.playing).toBe(true);
		act(() => vi.advanceTimersByTime(1));
		expect(result.current.playing).toBe(false);
		expect(result.current.ended).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		act(() => vi.advanceTimersByTime(22000));
		expect(result.current.index).toBe(2);
	});

	it("pauses without timers and resumes the same event before advancing", () => {
		const { result } = setup();
		act(() => result.current.playPause());
		act(() => vi.advanceTimersByTime(1000));
		act(() => result.current.playPause());
		expect(result.current.ended).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
		act(() => vi.advanceTimersByTime(10000));
		expect(result.current.currentRecord).toBe(first);
		act(() => result.current.playPause());
		expect(result.current.revision).toBe(1);
		act(() => vi.advanceTimersByTime(defaultInterval));
		expect(result.current.currentRecord).toBe(second);
	});

	it("changes pace during playback and ignores invalid speeds", () => {
		const { result } = setup();
		act(() => result.current.playPause());
		act(() => result.current.setSpeed(2));
		act(() => vi.advanceTimersByTime(813));
		expect(result.current.currentRecord).toBe(first);
		act(() => vi.advanceTimersByTime(1));
		expect(result.current.currentRecord).toBe(second);
		act(() => {
			result.current.setSpeed(0);
			result.current.setSpeed(-1);
			result.current.setSpeed(Number.NaN);
		});
		expect(result.current.speed).toBe(2);
	});

	it.each([[0.25, 4400 / 0.9], [0.5, 2200 / 0.9], [1, 1100 / 0.675], [2, 1100 / 1.35], [4, 1100 / 2.7], [8, 1100 / 5.4]])("runs %s× at the calibrated pace", (speed, duration) => {
		const { result } = setup();
		act(() => result.current.setSpeed(speed));
		expect(result.current.intervalMs).toBeCloseTo(duration);
		act(() => result.current.playPause());
		act(() => vi.advanceTimersByTime(Math.floor(duration) - 1));
		expect(result.current.currentRecord).toBe(first);
		act(() => vi.advanceTimersByTime(1));
		expect(result.current.currentRecord).toBe(second);
	});

	it("steps, seeks and clamps while pausing; repeated activation triggers a new revision", () => {
		const { result } = setup();
		act(() => result.current.step(-1));
		expect(result.current.currentRecord).toBe(second);
		act(() => result.current.step(-1));
		expect(result.current.currentRecord).toBe(first);
		act(() => result.current.step(1));
		expect(result.current.currentRecord).toBe(second);
		act(() => result.current.seek(100));
		expect(result.current.currentRecord).toBe(third);
		act(() => result.current.seek(-100));
		expect(result.current.currentRecord).toBe(first);
		const revision = result.current.revision;
		act(() => result.current.seek(0));
		expect(result.current.revision).toBe(revision + 1);
		act(() => result.current.restart());
		expect(result.current.revision).toBe(revision + 2);
		expect(result.current.playing).toBe(true);
		act(() => result.current.step(1));
		expect(result.current.currentRecord).toBe(second);
		expect(result.current.playing).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("steps from live relative to the latest event and clamps forward at that event", () => {
		const { result } = setup();
		act(() => result.current.step(1));
		expect(result.current.currentRecord).toBe(third);
		expect(result.current.playing).toBe(false);
		act(() => result.current.live());
		act(() => result.current.step(-1));
		expect(result.current.currentRecord).toBe(second);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("holds its sequence through fresh arrivals and refreshed object identities until restart or live", () => {
		const { result, rerender } = setup();
		act(() => result.current.seek(1));
		const snapshot = result.current.events;
		const earlier = record("earlier", 0);
		const latest = record("latest", 4);
		const fresh = [
			latest,
			...records.map((item) => ({ ...item, row: { ...item.row } })),
			earlier,
		];
		rerender({ events: messageEvents(fresh), enabled: true, scopeKey: "project" });
		expect(result.current.events).toBe(snapshot);
		expect(result.current.currentRecord).toBe(second);
		act(() => result.current.step(1));
		expect(result.current.currentRecord).toBe(third);
		act(() => result.current.restart());
		expect(result.current.currentRecord).toBe(earlier);
		expect(result.current.events).toHaveLength(5);
		act(() => result.current.live());
		expect(result.current.index).toBe(-1);
		expect(result.current.currentRecord).toBeNull();
		expect(result.current.playing).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("gives a restarted first event its full duration", () => {
		const { result } = setup();
		act(() => result.current.playPause());
		act(() => vi.advanceTimersByTime(2000));
		act(() => result.current.restart());
		act(() => vi.advanceTimersByTime(defaultInterval - 1));
		expect(result.current.currentRecord).toBe(first);
		act(() => vi.advanceTimersByTime(1));
		expect(result.current.currentRecord).toBe(second);
	});

	it("releases timers and replay state when disabled, changing scope, or unmounting", () => {
		const { result, rerender, unmount } = setup();
		act(() => result.current.playPause());
		rerender({ events: baseEvents, enabled: false, scopeKey: "project" });
		expect(result.current.index).toBe(-1);
		expect(vi.getTimerCount()).toBe(0);
		act(() => result.current.playPause());
		expect(result.current.playing).toBe(false);
		rerender({ events: baseEvents, enabled: true, scopeKey: "project" });
		expect(result.current.index).toBe(-1);
		act(() => result.current.playPause());
		rerender({ events: messageEvents([third]), enabled: true, scopeKey: "another-project" });
		expect(result.current.events.flatMap((event) => (event.kind === "message" ? [event.record] : []))).toEqual([third]);
		expect(result.current.index).toBe(-1);
		expect(vi.getTimerCount()).toBe(0);
		rerender({ events: baseEvents, enabled: true, scopeKey: "another-project" });
		act(() => result.current.playPause());
		expect(vi.getTimerCount()).toBe(1);
		unmount();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("leaves empty history idle and gives a single event its full playback duration", () => {
		const { result, rerender } = setup({
			events: [],
			enabled: true,
			scopeKey: "project",
		});
		act(() => {
			result.current.playPause();
			result.current.restart();
			result.current.step(1);
			result.current.seek(0);
		});
		expect(result.current.index).toBe(-1);
		expect(result.current.revision).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		rerender({ events: messageEvents([first]), enabled: true, scopeKey: "project" });
		act(() => result.current.playPause());
		expect(result.current.currentRecord).toBe(first);
		expect(result.current.playing).toBe(true);
		expect(vi.getTimerCount()).toBe(1);
		act(() => vi.advanceTimersByTime(defaultInterval - 1));
		expect(result.current.playing).toBe(true);
		act(() => vi.advanceTimersByTime(1));
		expect(result.current.playing).toBe(false);
		expect(result.current.currentRecord).toBe(first);
		expect(result.current.revision).toBe(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	describe("seekToTime — the entry range", () => {
		const atSecond = (second: number) => Date.UTC(2026, 8, 7, 10, 0, second);

		it("lands on the first event at or after the time and reports that it did", () => {
			const { result } = setup();
			let landed = false;
			act(() => { landed = result.current.seekToTime(atSecond(2)); });
			expect(landed).toBe(true);
			expect(result.current.currentRecord).toBe(second);
			expect(result.current.cursor.at).toBe(atSecond(2));
			// Between two events it moves forward, never back onto the earlier one.
			act(() => { result.current.seekToTime(atSecond(1) + 500); });
			expect(result.current.currentRecord).toBe(second);
		});

		it("moves nothing and says so when every event precedes the range", () => {
			const { result } = setup();
			let landed = true;
			act(() => { landed = result.current.seekToTime(atSecond(30)); });
			// A silent jump to the top would read as "the hour started here".
			expect(landed).toBe(false);
			expect(result.current.index).toBe(-1);
			expect(result.current.cursor.at).toBeNull();
		});

		it("does not start playing unless asked, and a manual pause survives a re-seek", () => {
			const { result } = setup();
			act(() => { result.current.seekToTime(atSecond(0)); });
			expect(result.current.playing).toBe(false);
			expect(vi.getTimerCount()).toBe(0);
			act(() => { result.current.seekToTime(atSecond(0), true); });
			expect(result.current.playing).toBe(true);
			act(() => result.current.playPause());
			expect(result.current.playing).toBe(false);
			// An entry seek repeated on an already-paused replay must not resume it.
			act(() => { result.current.seekToTime(atSecond(2)); });
			expect(result.current.playing).toBe(false);
			expect(vi.getTimerCount()).toBe(0);
		});

		it("rejects a non-finite time instead of clamping to the top", () => {
			const { result } = setup();
			act(() => { expect(result.current.seekToTime(Number.NaN)).toBe(false); });
			expect(result.current.index).toBe(-1);
		});
	});

	describe("cursor", () => {
		it("is live until a step, then carries the time and the kind", () => {
			const { result } = setup();
			expect(result.current.cursor).toMatchObject({ at: null, index: -1, total: 3, kind: null });
			act(() => result.current.seek(0));
			expect(result.current.cursor).toMatchObject({
				at: Date.UTC(2026, 8, 7, 10, 0, 1), index: 0, total: 3, kind: "message", playing: false,
			});
			act(() => result.current.live());
			expect(result.current.cursor.at).toBeNull();
		});
	});

	describe("a snapshot taken before the load settled", () => {
		// Board movements and notifications arrive after the first messages, so a
		// Play pressed during the load froze a timeline missing whole kinds of
		// event — and only a filter change or a Restart ever brought them back.
		const late = taskEvents(
			[
				{
					id: "receiver",
					projectId: "project",
					seq: 2,
					movements: [
						{ id: "m1", at: at(1.5), kind: "created", to: "todo" },
						{ id: "m2", at: at(2.5), kind: "moved", from: "todo", to: "in-progress" },
					],
				} as unknown as Task,
			],
			Date.UTC(2026, 8, 7, 10, 0, 0),
			Date.UTC(2026, 8, 7, 11, 0, 0),
		);
		const settled = [...baseEvents, ...late];

		function loading(events: TrafficTimelineEvent[] = baseEvents) {
			return renderHook(
				(props: { events: TrafficTimelineEvent[]; ready: boolean }) =>
					useTrafficPlayback(props.events, true, "project", props.ready),
				{ initialProps: { events, ready: false } },
			);
		}

		it("re-takes it when the late arms land, holding the reader in place", () => {
			const { result, rerender } = loading();
			act(() => result.current.playPause());
			expect(result.current.events).toHaveLength(3);
			rerender({ events: settled, ready: true });
			expect(result.current.events.map((event) => event.kind)).toEqual([
				"message", "task", "message", "task", "message",
			]);
			// Same event under the cursor, same playback state — only the index moved.
			expect(result.current.currentRecord).toBe(first);
			expect(result.current.index).toBe(0);
			expect(result.current.playing).toBe(true);
			act(() => vi.advanceTimersByTime(defaultInterval));
			expect(result.current.current?.kind).toBe("task");
		});

		it("re-takes it once, then holds against everything that arrives later", () => {
			const { result, rerender } = loading();
			act(() => result.current.seek(2));
			rerender({ events: settled, ready: true });
			expect(result.current.events).toHaveLength(5);
			expect(result.current.currentRecord).toBe(third);
			expect(result.current.index).toBe(4);
			const held = result.current.events;
			rerender({
				events: [...settled, ...messageEvents([record("latest", 9)])],
				ready: true,
			});
			expect(result.current.events).toBe(held);
			expect(result.current.index).toBe(4);
		});

		it("leaves a reader who never started in live mode", () => {
			const { result, rerender } = loading();
			rerender({ events: settled, ready: true });
			expect(result.current.index).toBe(-1);
			expect(result.current.events).toHaveLength(5);
			expect(result.current.playing).toBe(false);
			expect(vi.getTimerCount()).toBe(0);
		});
	});
});
