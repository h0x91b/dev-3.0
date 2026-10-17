/**
 * Ctrl+Backspace / Ctrl+Delete → word delete, through ghostty-web's real
 * InputHandler and WASM KeyEncoder, so the "without the fix" bytes are the
 * encoder's own output rather than an assumption.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { InputHandler, Ghostty } from "ghostty-web";
import { DELETE_WORD_LEFT, DELETE_WORD_RIGHT, getWordDeleteSequence } from "../word-delete-keys";

const SHIFT = 1, CTRL = 2, ALT = 4, META = 8;

function keyEvent(code: string, key: string, mods = 0, type = "keydown"): KeyboardEvent {
	return {
		type,
		code,
		key,
		shiftKey: !!(mods & SHIFT),
		ctrlKey: !!(mods & CTRL),
		altKey: !!(mods & ALT),
		metaKey: !!(mods & META),
		keyCode: 0,
		isComposing: false,
		preventDefault: () => {},
		stopPropagation: () => {},
	} as unknown as KeyboardEvent;
}

describe("getWordDeleteSequence", () => {
	it("maps Ctrl+Backspace to ^W and Ctrl+Delete to ESC d off macOS", () => {
		expect(getWordDeleteSequence(keyEvent("Backspace", "Backspace", CTRL), false)).toBe(DELETE_WORD_LEFT);
		expect(getWordDeleteSequence(keyEvent("Delete", "Delete", CTRL), false)).toBe(DELETE_WORD_RIGHT);
		expect(getWordDeleteSequence(keyEvent("NumpadDecimal", "Delete", CTRL), false)).toBe(DELETE_WORD_RIGHT);
	});

	it("leaves macOS alone", () => {
		expect(getWordDeleteSequence(keyEvent("Backspace", "Backspace", CTRL), true)).toBeNull();
		expect(getWordDeleteSequence(keyEvent("Delete", "Delete", CTRL), true)).toBeNull();
	});

	it("ignores other modifier combinations and keyup", () => {
		for (const mods of [0, SHIFT, ALT, CTRL | SHIFT, CTRL | ALT, CTRL | META]) {
			expect(getWordDeleteSequence(keyEvent("Backspace", "Backspace", mods), false)).toBeNull();
			expect(getWordDeleteSequence(keyEvent("Delete", "Delete", mods), false)).toBeNull();
		}
		expect(getWordDeleteSequence(keyEvent("Backspace", "Backspace", CTRL, "keyup"), false)).toBeNull();
		expect(getWordDeleteSequence(keyEvent("KeyW", "w", CTRL), false)).toBeNull();
	});
});

describe("word delete through ghostty-web InputHandler", () => {
	let ghostty: InstanceType<typeof Ghostty>;

	beforeAll(async () => {
		ghostty = await Ghostty.load();
	});

	function setup(withFix: boolean) {
		const sent: string[] = [];
		const listeners: Record<string, Function> = {};
		const container = {
			hasAttribute: () => false,
			setAttribute: () => {},
			style: {},
			addEventListener: (type: string, fn: Function) => { listeners[type] = fn; },
			removeEventListener: () => {},
		};
		const custom = (event: KeyboardEvent): boolean => {
			const seq = withFix ? getWordDeleteSequence(event, false) : null;
			if (seq) sent.push(seq);
			return seq !== null;
		};
		new InputHandler(ghostty, container as any, (data: string) => sent.push(data), () => {}, null as any, custom, null as any);
		return { sent, fire: (e: KeyboardEvent) => listeners.keydown?.(e) };
	}

	it("without the fix ghostty sends ^H and CSI 3;5~", () => {
		const { sent, fire } = setup(false);
		fire(keyEvent("Backspace", "Backspace", CTRL));
		fire(keyEvent("Delete", "Delete", CTRL));
		expect(sent).toEqual(["\x08", "\x1b[3;5~"]);
	});

	it("with the fix the word-delete sequences replace them", () => {
		const { sent, fire } = setup(true);
		fire(keyEvent("Backspace", "Backspace", CTRL));
		fire(keyEvent("Delete", "Delete", CTRL));
		expect(sent).toEqual([DELETE_WORD_LEFT, DELETE_WORD_RIGHT]);
	});

	it("plain Backspace and Delete are untouched", () => {
		const { sent, fire } = setup(true);
		fire(keyEvent("Backspace", "Backspace"));
		fire(keyEvent("Delete", "Delete"));
		expect(sent).toEqual(["\x7f", "\x1b[3~"]);
	});
});
