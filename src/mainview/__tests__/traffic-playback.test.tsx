import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrafficRecord } from "../components/agent-traffic/traffic-model";
import { useTrafficPlayback } from "../components/agent-traffic/useTrafficPlayback";

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

function setup(initial = { records, enabled: true, scopeKey: "project" }) {
	return renderHook(
		(props) => useTrafficPlayback(props.records, props.enabled, props.scopeKey),
		{ initialProps: initial },
	);
}

describe("traffic playback", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("starts in live mode with chronological events without mutating the log", () => {
		const { result } = setup();
		expect(result.current.events).toEqual([first, second, third]);
		expect(records).toEqual([third, second, first]);
		expect(result.current.index).toBe(-1);
		expect(result.current.current).toBeNull();
		expect(result.current.playing).toBe(false);
		expect(result.current.speed).toBe(0.5);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("activates immediately, advances at the selected pace, and stays at the end", () => {
		const { result } = setup();
		act(() => result.current.playPause());
		expect(result.current.current).toBe(first);
		expect(result.current.revision).toBe(1);
		act(() => vi.advanceTimersByTime(2199));
		expect(result.current.current).toBe(first);
		act(() => vi.advanceTimersByTime(1));
		expect(result.current.current).toBe(second);
		act(() => vi.advanceTimersByTime(2200));
		expect(result.current.current).toBe(third);
		expect(result.current.revision).toBe(3);
		expect(result.current.playing).toBe(true);
		act(() => vi.advanceTimersByTime(2199));
		expect(result.current.playing).toBe(true);
		act(() => vi.advanceTimersByTime(1));
		expect(result.current.playing).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
		act(() => vi.advanceTimersByTime(22000));
		expect(result.current.index).toBe(2);
	});

	it("pauses without timers and resumes the same event before advancing", () => {
		const { result } = setup();
		act(() => result.current.playPause());
		act(() => vi.advanceTimersByTime(1000));
		act(() => result.current.playPause());
		expect(vi.getTimerCount()).toBe(0);
		act(() => vi.advanceTimersByTime(10000));
		expect(result.current.current).toBe(first);
		act(() => result.current.playPause());
		expect(result.current.revision).toBe(1);
		act(() => vi.advanceTimersByTime(2200));
		expect(result.current.current).toBe(second);
	});

	it("changes pace during playback and ignores invalid speeds", () => {
		const { result } = setup();
		act(() => result.current.playPause());
		act(() => result.current.setSpeed(2));
		act(() => vi.advanceTimersByTime(549));
		expect(result.current.current).toBe(first);
		act(() => vi.advanceTimersByTime(1));
		expect(result.current.current).toBe(second);
		act(() => {
			result.current.setSpeed(0);
			result.current.setSpeed(-1);
			result.current.setSpeed(Number.NaN);
		});
		expect(result.current.speed).toBe(2);
	});

	it("steps, seeks and clamps while pausing; repeated activation triggers a new revision", () => {
		const { result } = setup();
		act(() => result.current.step(-1));
		expect(result.current.current).toBe(second);
		act(() => result.current.step(-1));
		expect(result.current.current).toBe(first);
		act(() => result.current.step(1));
		expect(result.current.current).toBe(second);
		act(() => result.current.seek(100));
		expect(result.current.current).toBe(third);
		act(() => result.current.seek(-100));
		expect(result.current.current).toBe(first);
		const revision = result.current.revision;
		act(() => result.current.seek(0));
		expect(result.current.revision).toBe(revision + 1);
		act(() => result.current.restart());
		expect(result.current.revision).toBe(revision + 2);
		expect(result.current.playing).toBe(true);
		act(() => result.current.step(1));
		expect(result.current.current).toBe(second);
		expect(result.current.playing).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("steps from live relative to the latest event and clamps forward at that event", () => {
		const { result } = setup();
		act(() => result.current.step(1));
		expect(result.current.current).toBe(third);
		expect(result.current.playing).toBe(false);
		act(() => result.current.live());
		act(() => result.current.step(-1));
		expect(result.current.current).toBe(second);
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
		rerender({ records: fresh, enabled: true, scopeKey: "project" });
		expect(result.current.events).toBe(snapshot);
		expect(result.current.current).toBe(second);
		act(() => result.current.step(1));
		expect(result.current.current).toBe(third);
		act(() => result.current.restart());
		expect(result.current.current).toBe(earlier);
		expect(result.current.events).toHaveLength(5);
		act(() => result.current.live());
		expect(result.current.index).toBe(-1);
		expect(result.current.current).toBeNull();
		expect(result.current.playing).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("gives a restarted first event its full duration", () => {
		const { result } = setup();
		act(() => result.current.playPause());
		act(() => vi.advanceTimersByTime(2000));
		act(() => result.current.restart());
		act(() => vi.advanceTimersByTime(2199));
		expect(result.current.current).toBe(first);
		act(() => vi.advanceTimersByTime(1));
		expect(result.current.current).toBe(second);
	});

	it("releases timers and replay state when disabled, changing scope, or unmounting", () => {
		const { result, rerender, unmount } = setup();
		act(() => result.current.playPause());
		rerender({ records, enabled: false, scopeKey: "project" });
		expect(result.current.index).toBe(-1);
		expect(vi.getTimerCount()).toBe(0);
		act(() => result.current.playPause());
		expect(result.current.playing).toBe(false);
		rerender({ records, enabled: true, scopeKey: "project" });
		expect(result.current.index).toBe(-1);
		act(() => result.current.playPause());
		rerender({ records: [third], enabled: true, scopeKey: "another-project" });
		expect(result.current.events).toEqual([third]);
		expect(result.current.index).toBe(-1);
		expect(vi.getTimerCount()).toBe(0);
		rerender({ records, enabled: true, scopeKey: "another-project" });
		act(() => result.current.playPause());
		expect(vi.getTimerCount()).toBe(1);
		unmount();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("leaves empty history idle and gives a single event its full playback duration", () => {
		const { result, rerender } = setup({
			records: [],
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
		rerender({ records: [first], enabled: true, scopeKey: "project" });
		act(() => result.current.playPause());
		expect(result.current.current).toBe(first);
		expect(result.current.playing).toBe(true);
		expect(vi.getTimerCount()).toBe(1);
		act(() => vi.advanceTimersByTime(2199));
		expect(result.current.playing).toBe(true);
		act(() => vi.advanceTimersByTime(1));
		expect(result.current.playing).toBe(false);
		expect(result.current.current).toBe(first);
		expect(result.current.revision).toBe(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});
