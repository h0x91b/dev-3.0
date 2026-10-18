/**
 * Ctrl+Backspace → word delete, through ghostty-web's real InputHandler and WASM
 * KeyEncoder, so the "without the fix" bytes are the encoder's own output. Ctrl+Delete
 * keeps ghostty's CSI 3;5~ — tmux turns it into a word delete (tmux/config.ts).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { InputHandler, Ghostty } from "ghostty-web";
import { DELETE_WORD_LEFT, getWordDeleteSequence } from "../word-delete-keys";
import { getTerminalKeyOverride } from "../terminal-key-overrides";

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
	it("maps Ctrl+Backspace to ^W off macOS", () => {
		expect(getWordDeleteSequence(keyEvent("Backspace", "Backspace", CTRL), false)).toBe(DELETE_WORD_LEFT);
	});

	it("leaves Ctrl+Delete to ghostty, so neovim on the alternate screen still decodes it", () => {
		expect(getWordDeleteSequence(keyEvent("Delete", "Delete", CTRL), false)).toBeNull();
		expect(getWordDeleteSequence(keyEvent("NumpadDecimal", "Delete", CTRL), false)).toBeNull();
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

describe("getTerminalKeyOverride", () => {
	it("translates word delete only on a tmux stream", () => {
		expect(getTerminalKeyOverride(keyEvent("Backspace", "Backspace", CTRL), true, false)).toBe(DELETE_WORD_LEFT);
		expect(getTerminalKeyOverride(keyEvent("Delete", "Delete", CTRL), true, false)).toBeNull();
	});

	it("leaves Ctrl+Backspace to ghostty on the native backend, where ConPTY reads ^H", () => {
		expect(getTerminalKeyOverride(keyEvent("Backspace", "Backspace", CTRL), false, false)).toBeNull();
		expect(getTerminalKeyOverride(keyEvent("Delete", "Delete", CTRL), false, false)).toBeNull();
	});

	it("keeps the Shift-key fix on both backends", () => {
		expect(getTerminalKeyOverride(keyEvent("Delete", "Delete", SHIFT), false, false)).toBe("\x1b[3;2~");
		expect(getTerminalKeyOverride(keyEvent("Delete", "Delete", SHIFT), true, false)).toBe("\x1b[3;2~");
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
			const seq = withFix ? getTerminalKeyOverride(event, true, false) : null;
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

	it("with the fix ^W replaces ^H, and Ctrl+Delete reaches tmux as CSI 3;5~", () => {
		const { sent, fire } = setup(true);
		fire(keyEvent("Backspace", "Backspace", CTRL));
		fire(keyEvent("Delete", "Delete", CTRL));
		expect(sent).toEqual([DELETE_WORD_LEFT, "\x1b[3;5~"]);
	});

	it("plain Backspace and Delete are untouched", () => {
		const { sent, fire } = setup(true);
		fire(keyEvent("Backspace", "Backspace"));
		fire(keyEvent("Delete", "Delete"));
		expect(sent).toEqual(["\x7f", "\x1b[3~"]);
	});
});
