/**
 * Machine-readable key bindings — the layer that lets `keymap.ts` both *describe*
 * and *dispatch* a shortcut, and lets the user rebind one.
 *
 * A binding is a physical key (`KeyboardEvent.code`, so it survives Cyrillic /
 * Hebrew / Dvorak layouts) plus an exact modifier set. `Mod` is the platform's
 * app modifier: ⌘ on macOS, Ctrl elsewhere. Matching is exact — a binding with
 * `["Mod"]` does not fire when Shift is also down, which is what keeps ⌘[ and
 * ⇧⌘[ apart.
 */

import { isMac } from "./utils/platform";

export type ModToken = "Mod" | "Meta" | "Ctrl" | "Shift" | "Alt";

export interface Binding {
	/** `KeyboardEvent.code` — the physical key. */
	code: string;
	/** Exact modifier set; every modifier not listed must be up. */
	mods: ModToken[];
	/** Restrict to one platform (only used by defaults, never by user overrides). */
	platform?: "mac" | "other";
	/** Unbound in browser remote mode because the browser owns the combo. */
	desktopOnly?: boolean;
}

/** Canonical order for the persisted string form — platform-independent. */
const MOD_ORDER: ModToken[] = ["Ctrl", "Alt", "Shift", "Meta", "Mod"];

/**
 * Display order differs by platform: macOS prints ⌃⌥⇧⌘ with Command last, while
 * Linux/Windows print Ctrl+Alt+Shift with Ctrl first. Since `Mod` *is* Command on
 * one and Ctrl on the other, it cannot sit at a fixed position.
 */
const DISPLAY_ORDER: Record<"mac" | "other", ModToken[]> = {
	mac: ["Ctrl", "Alt", "Shift", "Meta", "Mod"],
	other: ["Mod", "Meta", "Ctrl", "Alt", "Shift"],
};

/** Modifier-only keys can never be a binding on their own. */
const MODIFIER_CODES = new Set([
	"MetaLeft", "MetaRight", "ControlLeft", "ControlRight",
	"ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "CapsLock",
]);

/**
 * Keys the app refuses to hand over. `Escape` closes every layer, `Tab` is focus
 * traversal plus the task switcher, `Enter`/`Space` activate the focused control —
 * rebinding any of them turns the UI unusable with no way back.
 */
export const RESERVED_CODES = new Set(["Escape", "Tab", "Enter", "NumpadEnter", "Space"]);

/** `KeyboardEvent.code` → the label printed on the physical key. */
const CODE_LABELS: Record<string, string> = {
	Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
	Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
	Space: "Space", Enter: "Enter", Tab: "Tab", Escape: "Esc", Backspace: "Backspace",
	Delete: "Delete", Home: "Home", End: "End", PageUp: "PgUp", PageDown: "PgDn",
	ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
	NumpadSubtract: "-", NumpadAdd: "+", NumpadEnter: "Enter",
};

/** The human label for a physical key code (`"KeyK"` → `"K"`). */
export function codeLabel(code: string): string {
	if (CODE_LABELS[code]) return CODE_LABELS[code];
	if (/^Key[A-Z]$/.test(code)) return code.slice(3);
	if (/^Digit[0-9]$/.test(code)) return code.slice(5);
	if (/^Numpad[0-9]$/.test(code)) return `Num${code.slice(6)}`;
	return code;
}

/** The symbol/word for one modifier on the given platform. */
function modLabel(mod: ModToken, mac: boolean): string {
	switch (mod) {
		case "Mod": return mac ? "⌘" : "Ctrl";
		case "Meta": return mac ? "⌘" : "Win";
		case "Ctrl": return mac ? "⌃" : "Ctrl";
		case "Shift": return mac ? "⇧" : "Shift";
		case "Alt": return mac ? "⌥" : "Alt";
	}
}

/** Modifiers in canonical display order (⌃⌥⇧⌘ on mac, Ctrl+Alt+Shift on Linux). */
function displayMods(mods: ModToken[], mac: boolean): ModToken[] {
	const order = DISPLAY_ORDER[mac ? "mac" : "other"];
	return [...mods].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/** Modifiers in the fixed order used for persistence and equality. */
function storedMods(mods: ModToken[]): ModToken[] {
	return [...mods].sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
}

/** Render a binding for display (`"⇧⌘P"` / `"Ctrl+Shift+P"`). */
export function formatBinding(binding: Binding, mac: boolean = isMac()): string {
	const parts = displayMods(binding.mods, mac).map((m) => modLabel(m, mac));
	parts.push(codeLabel(binding.code));
	return mac ? parts.join("") : parts.join("+");
}

/** Render a binding as separate chips, for the settings editor's key pills. */
export function bindingChips(binding: Binding, mac: boolean = isMac()): string[] {
	return [...displayMods(binding.mods, mac).map((m) => modLabel(m, mac)), codeLabel(binding.code)];
}

/** Render a list of alternative bindings as one string (`"F11 / ⇧⌘F"`). */
export function formatBindings(bindings: Binding[], mac: boolean = isMac()): string {
	return bindings.map((b) => formatBinding(b, mac)).join(" / ");
}

/** Stable string form used for persistence and equality (`"Mod+Shift+KeyP"`). */
export function serializeBinding(binding: Binding): string {
	return [...storedMods(binding.mods), binding.code].join("+");
}

/** Parse the persisted string form back into a binding; `null` when malformed. */
export function parseBinding(raw: string): Binding | null {
	const parts = raw.split("+").filter(Boolean);
	if (parts.length === 0) return null;
	const code = parts[parts.length - 1];
	const mods: ModToken[] = [];
	for (const part of parts.slice(0, -1)) {
		if (!MOD_ORDER.includes(part as ModToken)) return null;
		mods.push(part as ModToken);
	}
	if (MODIFIER_CODES.has(code)) return null;
	return { code, mods };
}

export function bindingsEqual(a: Binding, b: Binding): boolean {
	return serializeBinding(a) === serializeBinding(b);
}

/** A binding with no modifier beyond Shift — fires only outside a typing context. */
export function isBareKeyBinding(binding: Binding): boolean {
	return binding.mods.every((m) => m === "Shift");
}

/** Which raw modifiers a binding requires on this platform. */
function requiredModifiers(binding: Binding, mac: boolean) {
	const need = { meta: false, ctrl: false, shift: false, alt: false };
	for (const mod of binding.mods) {
		if (mod === "Mod") { if (mac) need.meta = true; else need.ctrl = true; }
		else if (mod === "Meta") need.meta = true;
		else if (mod === "Ctrl") need.ctrl = true;
		else if (mod === "Shift") need.shift = true;
		else need.alt = true;
	}
	return need;
}

/** `code` → the characters that key produces, unshifted and shifted. */
const CODE_CHARS: Record<string, [string, string]> = {
	Backquote: ["`", "~"], Minus: ["-", "_"], Equal: ["=", "+"],
	BracketLeft: ["[", "{"], BracketRight: ["]", "}"], Backslash: ["\\", "|"],
	Semicolon: [";", ":"], Quote: ["'", '"'], Comma: [",", "<"],
	Period: [".", ">"], Slash: ["/", "?"],
	Digit0: ["0", ")"], Digit1: ["1", "!"], Digit2: ["2", "@"], Digit3: ["3", "#"],
	Digit4: ["4", "$"], Digit5: ["5", "%"], Digit6: ["6", "^"], Digit7: ["7", "&"],
	Digit8: ["8", "*"], Digit9: ["9", "("],
};

/**
 * Fallback for events that carry no usable `code`. Real browsers always set it,
 * but soft keyboards (Android in remote mode) and some remote-desktop stacks
 * report `""` or `"Unknown"`, and then `key` is all we have. Layout-dependent by
 * nature — hence a fallback, never the primary path.
 */
function keyMatches(e: KeyboardEvent, code: string): boolean {
	const k = e.key;
	if (!k) return false;
	const letter = /^Key([A-Z])$/.exec(code);
	if (letter) return k.toLowerCase() === letter[1].toLowerCase();
	const chars = CODE_CHARS[code];
	if (chars) return k === chars[0] || k === chars[1];
	return k === code; // F11, ArrowUp, Home, …
}

/** Whether the physical key matches, preferring `code` over the layout-bound `key`. */
function codeMatches(e: KeyboardEvent, code: string): boolean {
	if (e.code && e.code !== "Unknown") return e.code === code;
	return keyMatches(e, code);
}

export interface MatchContext {
	mac: boolean;
	remote: boolean;
	/** True when focus is in a field or the terminal — suppresses bare-key bindings. */
	typing: boolean;
}

/** Whether a keydown event fires this binding. */
export function matchesBinding(e: KeyboardEvent, binding: Binding, ctx: MatchContext): boolean {
	if (binding.platform && (binding.platform === "mac") !== ctx.mac) return false;
	if (binding.desktopOnly && ctx.remote) return false;
	if (!codeMatches(e, binding.code)) return false;
	if (ctx.typing && isBareKeyBinding(binding)) return false;
	const need = requiredModifiers(binding, ctx.mac);
	return e.metaKey === need.meta && e.ctrlKey === need.ctrl
		&& e.shiftKey === need.shift && e.altKey === need.alt;
}

/**
 * Turn a live keydown into the binding it would record. Returns `null` while only
 * modifiers are held, so the recorder can keep showing "press a combo".
 */
export function bindingFromEvent(e: KeyboardEvent, mac: boolean = isMac()): Binding | null {
	if (MODIFIER_CODES.has(e.code)) return null;
	const mods: ModToken[] = [];
	// The platform's app modifier records as `Mod` so the combo travels between
	// macOS and Linux; the other one records literally.
	if (mac) {
		if (e.metaKey) mods.push("Mod");
		if (e.ctrlKey) mods.push("Ctrl");
	} else {
		if (e.ctrlKey) mods.push("Mod");
		if (e.metaKey) mods.push("Meta");
	}
	if (e.altKey) mods.push("Alt");
	if (e.shiftKey) mods.push("Shift");
	return { code: e.code, mods };
}

export type BindingRejection = "reserved" | "modifier-only";

/** Why a recorded binding cannot be accepted, or `null` when it is fine. */
export function rejectBinding(binding: Binding): BindingRejection | null {
	if (MODIFIER_CODES.has(binding.code)) return "modifier-only";
	if (RESERVED_CODES.has(binding.code) && binding.mods.length === 0) return "reserved";
	return null;
}
