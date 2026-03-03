/**
 * Integration test: our Shift+key fix running through ghostty-web's
 * real InputHandler and WASM KeyEncoder.
 *
 * No mocking — we instantiate the actual InputHandler with the real
 * Ghostty WASM instance, attach our custom handler, simulate keydown
 * events, and verify the escape sequences that come out.
 *
 * If ghostty-web changes its encoding or fixes the bug upstream,
 * these tests will catch the behavioral change.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { InputHandler, Ghostty } from "ghostty-web";
import { SHIFT_KEY_SEQUENCES, getShiftKeySequence } from "../shift-key-sequences";

/**
 * Build a custom key handler using the production getShiftKeySequence().
 * The only difference from TerminalView: sends to `sent[]` instead of ws.
 */
function makeCustomHandler(sent: string[]) {
	return (event: KeyboardEvent): boolean => {
		const seq = getShiftKeySequence(event);
		if (seq) {
			sent.push(seq);
			return true;
		}
		return false;
	};
}

// Helpers
const SHIFT = 1, CTRL = 2, ALT = 4;

function keyEvent(code: string, key: string, mods = 0): KeyboardEvent {
	return {
		type: "keydown",
		code,
		key,
		shiftKey: !!(mods & SHIFT),
		ctrlKey: !!(mods & CTRL),
		altKey: !!(mods & ALT),
		metaKey: false,
		keyCode: 0,
		isComposing: false,
		preventDefault: () => {},
		stopPropagation: () => {},
	} as unknown as KeyboardEvent;
}

/**
 * Minimal container stub — InputHandler only needs addEventListener
 * to register its keydown listener.  We capture the listener so we
 * can fire synthetic events through it.
 */
function makeContainer() {
	const listeners: Record<string, Function> = {};
	return {
		obj: {
			hasAttribute: () => false,
			setAttribute: () => {},
			style: {},
			addEventListener: (type: string, fn: Function) => { listeners[type] = fn; },
			removeEventListener: () => {},
		},
		fire(event: KeyboardEvent) { listeners.keydown?.(event); },
	};
}

describe("Shift+key integration (ghostty-web InputHandler)", () => {
	let ghostty: InstanceType<typeof Ghostty>;

	beforeAll(async () => {
		ghostty = await Ghostty.load();
	});

	/** Create a fresh InputHandler wired to our custom handler. */
	function setup() {
		const sent: string[] = [];
		const container = makeContainer();
		new InputHandler(
			ghostty,
			container.obj as any,
			(data: string) => sent.push(data),   // onData (ghostty-web output)
			() => {},                              // onBell
			null as any,                           // onKey
			makeCustomHandler(sent),               // our fix
			null as any,                           // getMode
		);
		return { sent, fire: container.fire };
	}

	// ── Shift+key combinations (our handler intercepts) ──────────

	it("Shift+Tab sends back-tab (CSI Z)", () => {
		const { sent, fire } = setup();
		fire(keyEvent("Tab", "Tab", SHIFT));
		expect(sent).toEqual(["\x1b[Z"]);
	});

	it("Shift+Enter sends modifyOtherKeys Shift+Enter", () => {
		const { sent, fire } = setup();
		fire(keyEvent("Enter", "Enter", SHIFT));
		expect(sent).toEqual(["\x1b[27;2;13~"]);
	});

	it("Shift+Home sends modified Home sequence", () => {
		const { sent, fire } = setup();
		fire(keyEvent("Home", "Home", SHIFT));
		expect(sent).toEqual(["\x1b[1;2H"]);
	});

	it("Shift+End sends modified End sequence", () => {
		const { sent, fire } = setup();
		fire(keyEvent("End", "End", SHIFT));
		expect(sent).toEqual(["\x1b[1;2F"]);
	});

	it("Shift+F5 sends modified F5 sequence", () => {
		const { sent, fire } = setup();
		fire(keyEvent("F5", "F5", SHIFT));
		expect(sent).toEqual(["\x1b[15;2~"]);
	});

	// ── Unmodified keys (our handler does NOT intercept) ─────────

	it("plain Tab passes through to ghostty-web encoder", () => {
		const { sent, fire } = setup();
		fire(keyEvent("Tab", "Tab"));
		expect(sent).toEqual(["\t"]);
	});

	it("plain Enter passes through to ghostty-web encoder", () => {
		const { sent, fire } = setup();
		fire(keyEvent("Enter", "Enter"));
		expect(sent).toEqual(["\r"]);
	});

	// ── Multi-modifier combos (our handler does NOT intercept) ───

	it("Ctrl+Shift+Tab falls through to WASM encoder", () => {
		const { sent, fire } = setup();
		fire(keyEvent("Tab", "Tab", SHIFT | CTRL));
		// We don't assert the exact sequence — the encoder may change.
		// We assert: (a) exactly one sequence sent, (b) it's not plain \t.
		expect(sent).toHaveLength(1);
		expect(sent[0]).not.toBe("\t");
	});

	it("Alt+Tab falls through to WASM encoder", () => {
		const { sent, fire } = setup();
		fire(keyEvent("Tab", "Tab", ALT));
		expect(sent).toHaveLength(1);
		expect(sent[0]).not.toBe("\t");
	});

	// ── Guard: exactly one sequence per keypress ─────────────────

	it("our handler prevents double-send (handler + encoder)", () => {
		const { sent, fire } = setup();
		fire(keyEvent("Tab", "Tab", SHIFT));
		// If our handler returns true but ghostty-web ALSO sends,
		// we'd see two entries.  Must be exactly one.
		expect(sent).toHaveLength(1);
	});

	// ── Without our handler: demonstrates the bug ────────────────

	it("BUG REPRO: without fix, Shift+Tab sends plain tab", () => {
		const sent: string[] = [];
		const container = makeContainer();
		new InputHandler(
			ghostty,
			container.obj as any,
			(data: string) => sent.push(data),
			() => {},
			null as any,
			null as any,   // NO custom handler
			null as any,
		);
		container.fire(keyEvent("Tab", "Tab", SHIFT));
		// This test documents the bug.  If ghostty-web fixes it upstream,
		// this assertion will fail — which is exactly what we want to know.
		expect(sent).toEqual(["\t"]);
	});

	it("BUG REPRO: without fix, Shift+Enter sends plain CR", () => {
		const sent: string[] = [];
		const container = makeContainer();
		new InputHandler(
			ghostty,
			container.obj as any,
			(data: string) => sent.push(data),
			() => {},
			null as any,
			null as any,   // NO custom handler
			null as any,
		);
		container.fire(keyEvent("Enter", "Enter", SHIFT));
		expect(sent).toEqual(["\r"]);
	});

	// ── SHIFT_KEY_SEQUENCES map sanity checks ────────────────────

	it("map covers all expected functional keys", () => {
		const expectedKeys = [
			"Tab", "Enter", "Home", "End", "Insert", "Delete",
			"PageUp", "PageDown",
			"F1", "F2", "F3", "F4", "F5", "F6",
			"F7", "F8", "F9", "F10", "F11", "F12",
		];
		for (const key of expectedKeys) {
			expect(SHIFT_KEY_SEQUENCES).toHaveProperty(key);
		}
	});

	it("all sequences start with ESC[", () => {
		for (const [key, seq] of Object.entries(SHIFT_KEY_SEQUENCES)) {
			expect(seq.startsWith("\x1b["), `${key}: ${JSON.stringify(seq)} should start with ESC[`).toBe(true);
		}
	});
});
