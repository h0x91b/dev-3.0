import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useCompact, COMPACT_MAX_WIDTH } from "../useCompact";

interface FakeMql {
	matches: boolean;
	media: string;
	listeners: Set<() => void>;
	addEventListener: (type: string, cb: () => void) => void;
	removeEventListener: (type: string, cb: () => void) => void;
}

function installMatchMedia(initialMatches: boolean): {
	mql: FakeMql;
	setMatches: (next: boolean) => void;
} {
	const mql: FakeMql = {
		matches: initialMatches,
		media: `(max-width: ${COMPACT_MAX_WIDTH}px)`,
		listeners: new Set(),
		addEventListener(_type, cb) {
			this.listeners.add(cb);
		},
		removeEventListener(_type, cb) {
			this.listeners.delete(cb);
		},
	};
	Object.defineProperty(window, "matchMedia", {
		writable: true,
		configurable: true,
		value: vi.fn(() => mql),
	});
	return {
		mql,
		setMatches(next: boolean) {
			mql.matches = next;
			for (const cb of mql.listeners) cb();
		},
	};
}

describe("useCompact", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns true when the viewport is below the compact breakpoint", () => {
		installMatchMedia(true);
		const { result } = renderHook(() => useCompact());
		expect(result.current).toBe(true);
	});

	it("returns false when the viewport is wide", () => {
		installMatchMedia(false);
		const { result } = renderHook(() => useCompact());
		expect(result.current).toBe(false);
	});

	it("reacts to media-query changes", () => {
		const { setMatches } = installMatchMedia(false);
		const { result } = renderHook(() => useCompact());
		expect(result.current).toBe(false);
		act(() => setMatches(true));
		expect(result.current).toBe(true);
		act(() => setMatches(false));
		expect(result.current).toBe(false);
	});

	it("falls back to non-compact when matchMedia is unavailable", () => {
		Object.defineProperty(window, "matchMedia", {
			writable: true,
			configurable: true,
			value: undefined,
		});
		const { result } = renderHook(() => useCompact());
		expect(result.current).toBe(false);
	});
});
