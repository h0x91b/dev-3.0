import { describe, expect, it } from "vitest";
import {
	bindingChips,
	bindingFromEvent,
	bindingsEqual,
	codeLabel,
	formatBinding,
	formatBindings,
	isBareKeyBinding,
	matchesBinding,
	parseBinding,
	rejectBinding,
	serializeBinding,
	type Binding,
} from "../keymap-bindings";

function key(
	code: string,
	mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {},
	overrides: Partial<KeyboardEvent> = {},
): KeyboardEvent {
	return {
		code,
		key: "",
		metaKey: !!mods.meta,
		ctrlKey: !!mods.ctrl,
		shiftKey: !!mods.shift,
		altKey: !!mods.alt,
		...overrides,
	} as KeyboardEvent;
}

const ctx = { mac: true, remote: false, typing: false };

describe("formatting", () => {
	it("renders mac glyphs without separators and Linux words with plus signs", () => {
		const b: Binding = { code: "KeyP", mods: ["Mod", "Shift"] };
		expect(formatBinding(b, true)).toBe("⇧⌘P");
		expect(formatBinding(b, false)).toBe("Ctrl+Shift+P");
	});

	it("orders modifiers canonically regardless of how they were declared", () => {
		const a: Binding = { code: "KeyF", mods: ["Shift", "Mod"] };
		const b: Binding = { code: "KeyF", mods: ["Mod", "Shift"] };
		expect(formatBinding(a, true)).toBe(formatBinding(b, true));
		expect(serializeBinding(a)).toBe(serializeBinding(b));
	});

	it("labels physical codes with what is printed on the key", () => {
		expect(codeLabel("KeyK")).toBe("K");
		expect(codeLabel("Digit0")).toBe("0");
		expect(codeLabel("Backquote")).toBe("`");
		expect(codeLabel("BracketLeft")).toBe("[");
		expect(codeLabel("F11")).toBe("F11");
	});

	it("splits a combo into one chip per key", () => {
		expect(bindingChips({ code: "KeyP", mods: ["Mod", "Shift"] }, true)).toEqual(["⇧", "⌘", "P"]);
	});

	it("joins alternative bindings with a slash", () => {
		expect(
			formatBindings([{ code: "F11", mods: [] }, { code: "KeyF", mods: ["Mod", "Shift"] }], true),
		).toBe("F11 / ⇧⌘F");
	});
});

describe("serialization", () => {
	it("round-trips through the persisted string form", () => {
		const b: Binding = { code: "KeyP", mods: ["Mod", "Shift"] };
		expect(serializeBinding(b)).toBe("Shift+Mod+KeyP");
		const parsed = parseBinding(serializeBinding(b));
		expect(parsed).toEqual({ code: "KeyP", mods: ["Shift", "Mod"] });
		expect(bindingsEqual(parsed!, b)).toBe(true);
	});

	it("rejects an unknown modifier token instead of guessing", () => {
		expect(parseBinding("Hyper+KeyP")).toBeNull();
		expect(parseBinding("")).toBeNull();
		expect(parseBinding("Mod+ShiftLeft")).toBeNull();
	});

	it("parses a bare key", () => {
		expect(parseBinding("KeyC")).toEqual({ code: "KeyC", mods: [] });
	});
});

describe("matching", () => {
	it("requires the exact modifier set — extras do not match", () => {
		const b: Binding = { code: "KeyK", mods: ["Mod"] };
		expect(matchesBinding(key("KeyK", { meta: true }), b, ctx)).toBe(true);
		expect(matchesBinding(key("KeyK", { meta: true, shift: true }), b, ctx)).toBe(false);
		expect(matchesBinding(key("KeyK", { meta: true, alt: true }), b, ctx)).toBe(false);
		expect(matchesBinding(key("KeyK"), b, ctx)).toBe(false);
	});

	it("maps Mod to ⌘ on macOS and Ctrl elsewhere", () => {
		const b: Binding = { code: "KeyK", mods: ["Mod"] };
		expect(matchesBinding(key("KeyK", { ctrl: true }), b, ctx)).toBe(false);
		expect(matchesBinding(key("KeyK", { ctrl: true }), b, { ...ctx, mac: false })).toBe(true);
		expect(matchesBinding(key("KeyK", { meta: true }), b, { ...ctx, mac: false })).toBe(false);
	});

	it("falls back to `key` only when the event carries no usable code", () => {
		// Soft keyboards and some remote-desktop stacks report "Unknown"/"" here.
		const b: Binding = { code: "Minus", mods: ["Ctrl"] };
		expect(matchesBinding(key("Minus", { ctrl: true }), b, ctx)).toBe(true);
		expect(matchesBinding(key("Unknown", { ctrl: true }, { key: "-" }), b, ctx)).toBe(true);
		expect(matchesBinding(key("", { ctrl: true }, { key: "_" }), b, ctx)).toBe(true);
		expect(matchesBinding(key("Unknown", { ctrl: true }, { key: "x" }), b, ctx)).toBe(false);
		// A real code wins over the layout-bound key — no double matching.
		expect(matchesBinding(key("KeyX", { ctrl: true }, { key: "-" }), b, ctx)).toBe(false);
	});

	it("resolves a letter and a shifted digit through the key fallback", () => {
		expect(
			matchesBinding(key("Unknown", { meta: true }, { key: "k" }), { code: "KeyK", mods: ["Mod"] }, ctx),
		).toBe(true);
		expect(
			matchesBinding(
				key("Unknown", { meta: true, shift: true }, { key: ")" }),
				{ code: "Digit0", mods: ["Mod", "Shift"] },
				ctx,
			),
		).toBe(true);
	});

	it("drops a desktop-only binding in remote mode", () => {
		const b: Binding = { code: "KeyN", mods: ["Mod"], desktopOnly: true };
		expect(matchesBinding(key("KeyN", { meta: true }), b, ctx)).toBe(true);
		expect(matchesBinding(key("KeyN", { meta: true }), b, { ...ctx, remote: true })).toBe(false);
	});

	it("honours a platform-restricted binding", () => {
		const b: Binding = { code: "Minus", mods: ["Mod"], platform: "mac" };
		expect(matchesBinding(key("Minus", { meta: true }), b, ctx)).toBe(true);
		expect(matchesBinding(key("Minus", { ctrl: true }), b, { ...ctx, mac: false })).toBe(false);
	});

	it("suppresses bare and Shift-only bindings while typing", () => {
		expect(isBareKeyBinding({ code: "KeyC", mods: [] })).toBe(true);
		expect(isBareKeyBinding({ code: "KeyC", mods: ["Shift"] })).toBe(true);
		expect(isBareKeyBinding({ code: "KeyC", mods: ["Mod"] })).toBe(false);
		const bare: Binding = { code: "KeyC", mods: [] };
		expect(matchesBinding(key("KeyC"), bare, ctx)).toBe(true);
		expect(matchesBinding(key("KeyC"), bare, { ...ctx, typing: true })).toBe(false);
	});
});

describe("recording", () => {
	it("records the platform modifier as Mod so the combo travels between OSes", () => {
		expect(bindingFromEvent(key("KeyJ", { meta: true }), true)).toEqual({ code: "KeyJ", mods: ["Mod"] });
		expect(bindingFromEvent(key("KeyJ", { ctrl: true }), false)).toEqual({ code: "KeyJ", mods: ["Mod"] });
	});

	it("records the non-platform modifier literally", () => {
		expect(bindingFromEvent(key("KeyJ", { ctrl: true }), true)).toEqual({ code: "KeyJ", mods: ["Ctrl"] });
		expect(bindingFromEvent(key("KeyJ", { meta: true }), false)).toEqual({ code: "KeyJ", mods: ["Meta"] });
	});

	it("returns null while only modifiers are held, so the recorder keeps waiting", () => {
		expect(bindingFromEvent(key("MetaLeft", { meta: true }), true)).toBeNull();
		expect(bindingFromEvent(key("ShiftRight", { shift: true }), true)).toBeNull();
	});

	it("refuses the keys that are the way out of every dialog", () => {
		expect(rejectBinding({ code: "Escape", mods: [] })).toBe("reserved");
		expect(rejectBinding({ code: "Tab", mods: [] })).toBe("reserved");
		expect(rejectBinding({ code: "Space", mods: [] })).toBe("reserved");
		expect(rejectBinding({ code: "ControlLeft", mods: [] })).toBe("modifier-only");
		// With a modifier they are ordinary keys again.
		expect(rejectBinding({ code: "Tab", mods: ["Mod", "Shift"] })).toBeNull();
		expect(rejectBinding({ code: "KeyJ", mods: ["Mod"] })).toBeNull();
	});
});
