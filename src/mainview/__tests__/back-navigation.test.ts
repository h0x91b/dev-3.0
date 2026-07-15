import { describe, it, expect, beforeEach, vi } from "vitest";
import {
	registerBackLayer,
	closeTopBackLayer,
	backLayerCount,
	createBackPressHandler,
	isBackSentinelState,
	BACK_SENTINEL_STATE,
	DEFAULT_EXIT_WINDOW_MS,
	__resetBackLayersForTests,
	type BackPressDeps,
} from "../back-navigation";

beforeEach(() => {
	__resetBackLayersForTests();
});

// ── Layer stack ──────────────────────────────────────────────────────

describe("back-layer stack", () => {
	it("closes the most recently registered layer first", () => {
		const closedOrder: string[] = [];
		registerBackLayer(() => closedOrder.push("bottom"));
		registerBackLayer(() => closedOrder.push("top"));

		expect(closeTopBackLayer()).toBe(true);
		expect(closedOrder).toEqual(["top"]);
	});

	it("returns false when no layers are registered", () => {
		expect(closeTopBackLayer()).toBe(false);
	});

	it("unregister removes the layer regardless of position", () => {
		const closed: string[] = [];
		registerBackLayer(() => closed.push("a"));
		const unregisterB = registerBackLayer(() => closed.push("b"));
		const unregisterC = registerBackLayer(() => closed.push("c"));

		unregisterB();
		expect(backLayerCount()).toBe(2);

		closeTopBackLayer();
		// In the real flow closing unmounts the surface, whose effect cleanup
		// unregisters it — simulate that before the next press.
		unregisterC();
		closeTopBackLayer();
		expect(closed).toEqual(["c", "a"]);
	});

	it("unregister is idempotent", () => {
		const unregister = registerBackLayer(() => {});
		unregister();
		unregister();
		expect(backLayerCount()).toBe(0);
	});

	it("closing a layer does not auto-unregister it (the surface unmount does)", () => {
		// The close callback typically flips React state which unmounts the
		// surface and runs the effect cleanup; the stack itself must not guess.
		registerBackLayer(() => {});
		closeTopBackLayer();
		expect(backLayerCount()).toBe(1);
	});
});

// ── Back press handler ───────────────────────────────────────────────

function createDeps(overrides: Partial<BackPressDeps> = {}) {
	const deps = {
		closeTopLayer: vi.fn(() => false),
		routeBack: vi.fn(() => false),
		showExitToast: vi.fn(),
		armSentinel: vi.fn(),
		scheduleRearm: vi.fn(),
		...overrides,
	};
	return deps;
}

describe("createBackPressHandler", () => {
	it("closes the topmost layer and re-arms the sentinel", () => {
		const deps = createDeps({ closeTopLayer: vi.fn(() => true) });
		const handle = createBackPressHandler(deps);

		expect(handle()).toBe("layer-closed");
		expect(deps.armSentinel).toHaveBeenCalledOnce();
		expect(deps.routeBack).not.toHaveBeenCalled();
		expect(deps.showExitToast).not.toHaveBeenCalled();
	});

	it("falls through to route back when no layer is open", () => {
		const deps = createDeps({ routeBack: vi.fn(() => true) });
		const handle = createBackPressHandler(deps);

		expect(handle()).toBe("route-back");
		expect(deps.armSentinel).toHaveBeenCalledOnce();
		expect(deps.showExitToast).not.toHaveBeenCalled();
	});

	it("arms double-back-to-exit at the root: toast, no immediate re-arm, delayed re-arm scheduled", () => {
		const deps = createDeps();
		const handle = createBackPressHandler(deps);

		expect(handle()).toBe("exit-armed");
		expect(deps.showExitToast).toHaveBeenCalledOnce();
		// The sentinel must stay consumed so a second press exits natively…
		expect(deps.armSentinel).not.toHaveBeenCalled();
		// …and the guard is restored after the window closes.
		expect(deps.scheduleRearm).toHaveBeenCalledWith(deps.armSentinel, DEFAULT_EXIT_WINDOW_MS);
	});

	it("honours a custom exit window", () => {
		const deps = createDeps({ exitWindowMs: 500 });
		const handle = createBackPressHandler(deps);
		handle();
		expect(deps.scheduleRearm).toHaveBeenCalledWith(deps.armSentinel, 500);
	});

	it("layer close wins over route back", () => {
		const deps = createDeps({
			closeTopLayer: vi.fn(() => true),
			routeBack: vi.fn(() => true),
		});
		const handle = createBackPressHandler(deps);
		expect(handle()).toBe("layer-closed");
		expect(deps.routeBack).not.toHaveBeenCalled();
	});
});

// ── Sentinel state ───────────────────────────────────────────────────

describe("isBackSentinelState", () => {
	it("recognizes the sentinel state object", () => {
		expect(isBackSentinelState(BACK_SENTINEL_STATE)).toBe(true);
		expect(isBackSentinelState({ dev3BackSentinel: true })).toBe(true);
	});

	it("rejects everything else", () => {
		expect(isBackSentinelState(null)).toBe(false);
		expect(isBackSentinelState(undefined)).toBe(false);
		expect(isBackSentinelState({})).toBe(false);
		expect(isBackSentinelState({ dev3BackSentinel: false })).toBe(false);
		expect(isBackSentinelState("dev3BackSentinel")).toBe(false);
	});
});
