import { describe, it, expect, vi } from "vitest";
import { installRenderGuard, DEFAULT_STALL_MS, type GuardableRenderer } from "../terminal-render-guard";

/** A renderer whose paint the test controls, plus the vendor loop's own contract. */
function makeHarness(opts: { visible?: boolean } = {}) {
	const painted: number[] = [];
	let throwWith: Error | null = null;
	const renderer: GuardableRenderer = {
		render() {
			if (throwWith) throw throwWith;
			painted.push(1);
		},
	};
	let clock = 1_000;
	const timer: { fire: (() => void) | null } = { fire: null };
	let visible = opts.visible ?? true;
	const frameErrors: Array<{ error: string; consecutive: number }> = [];
	const stalls: number[] = [];

	const guard = installRenderGuard(renderer, {
		onFrameError: (error, consecutive) => frameErrors.push({ error: String(error), consecutive }),
		onStalled: (ms) => stalls.push(ms),
		now: () => clock,
		isVisible: () => visible,
		setInterval: (fn) => {
			timer.fire = fn;
			return 1;
		},
		clearInterval: () => {
			timer.fire = null;
		},
	});

	return {
		guard,
		frameErrors,
		stalls,
		painted,
		/** One frame from the vendor's loop. Returns false if it propagated a throw. */
		frame(): boolean {
			try {
				renderer.render({}, false, 0, {}, 1);
				return true;
			} catch {
				return false;
			}
		},
		crashWith(err: Error | null) {
			throwWith = err;
		},
		advance(ms: number) {
			clock += ms;
		},
		setVisible(v: boolean) {
			visible = v;
		},
		tick() {
			timer.fire?.();
		},
		isWatching: () => timer.fire !== null,
	};
}

describe("installRenderGuard – surviving a bad frame", () => {
	it("does not let a throwing frame escape, so the vendor loop lives", () => {
		const h = makeHarness();
		h.crashWith(new Error("RuntimeError: Out of bounds memory access"));

		expect(h.frame()).toBe(true);
		expect(h.frameErrors[0]).toMatchObject({ consecutive: 1 });
	});

	it("still paints once the bad frame passes", () => {
		const h = makeHarness();
		h.crashWith(new Error("boom"));
		h.frame();
		h.crashWith(null);

		h.frame();

		expect(h.guard.framesPainted()).toBe(1);
		expect(h.guard.consecutiveErrors()).toBe(0);
	});

	it("reports the first three failures, then only every 60th — a broken frame repeats at 60fps", () => {
		const h = makeHarness();
		h.crashWith(new Error("boom"));

		for (let i = 0; i < 120; i++) h.frame();

		expect(h.frameErrors.map((e) => e.consecutive)).toEqual([1, 2, 3, 60, 120]);
	});

	it("passes the terminal's own arguments through untouched", () => {
		const seen: unknown[][] = [];
		const renderer: GuardableRenderer = { render: (...args: unknown[]) => void seen.push(args) };
		installRenderGuard(renderer, {
			onFrameError: vi.fn(),
			onStalled: vi.fn(),
			setInterval: () => 1,
			clearInterval: () => {},
		});

		renderer.render("buffer", true, 42, "provider", 0.5);

		expect(seen[0]).toEqual(["buffer", true, 42, "provider", 0.5]);
	});
});

describe("installRenderGuard – noticing a loop that stopped", () => {
	it("reports a visible pane that painted nothing for too long", () => {
		const h = makeHarness();
		h.frame();
		h.advance(DEFAULT_STALL_MS + 1);

		h.tick();

		expect(h.stalls).toHaveLength(1);
		expect(h.stalls[0]).toBeGreaterThan(DEFAULT_STALL_MS);
	});

	it("stays quiet while frames keep arriving", () => {
		const h = makeHarness();
		for (let i = 0; i < 5; i++) {
			h.advance(1000);
			h.frame();
			h.tick();
		}
		expect(h.stalls).toEqual([]);
	});

	it("reports a stall once, not on every check", () => {
		const h = makeHarness();
		h.frame();
		h.advance(DEFAULT_STALL_MS + 1);
		h.tick();
		h.advance(DEFAULT_STALL_MS + 1);
		h.tick();

		expect(h.stalls).toHaveLength(1);
	});

	it("arms again after the pane recovers", () => {
		const h = makeHarness();
		h.frame();
		h.advance(DEFAULT_STALL_MS + 1);
		h.tick();
		h.frame();
		h.advance(DEFAULT_STALL_MS + 1);
		h.tick();

		expect(h.stalls).toHaveLength(2);
	});

	it("never blames a hidden window, which legitimately paints nothing", () => {
		const h = makeHarness();
		h.frame();
		h.setVisible(false);
		h.advance(DEFAULT_STALL_MS * 10);
		h.tick();

		expect(h.stalls).toEqual([]);
	});

	it("gives a window that just came back a fresh chance to paint", () => {
		const h = makeHarness();
		h.frame();
		h.setVisible(false);
		h.advance(DEFAULT_STALL_MS * 10);
		h.tick();
		h.setVisible(true);
		h.tick(); // first visible tick only restarts the clock
		h.advance(DEFAULT_STALL_MS - 1);
		h.tick();

		expect(h.stalls).toEqual([]);
	});

	it("stops watching and restores the vendor render on dispose", () => {
		const h = makeHarness();
		h.guard.dispose();
		h.frame();
		h.advance(DEFAULT_STALL_MS * 10);

		expect(h.isWatching()).toBe(false);
		expect(h.guard.framesPainted()).toBe(0);
	});
});
