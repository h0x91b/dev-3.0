import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Keeps keystrokes that were meant for something else from answering a dialog.
 *
 * A dialog that pops up on its own (an agent asking to cancel a task) lands in
 * the middle of whatever the user was typing. Without this, the next Space or
 * Enter clicks the focused button, Tab-then-Enter approves, a held key answers a
 * whole queue of dialogs, and bare letters fire app shortcuts behind it. See
 * `decisions/2026/10/16/dialog-keyboard-guard.md`.
 *
 * One capture listener on `window`, installed when this module is imported (so
 * it runs before every other window listener) and inert while no guarded dialog
 * is open. The most recently opened guarded dialog decides:
 *
 * - **Quiet arming** (`quietMs > 0`, for dialogs nobody asked for): every key is
 *   swallowed until the keyboard has been silent for `quietMs`, measured from
 *   the opening or the last keystroke. A pointer press inside the dialog arms it
 *   at once — the mouse is always deliberate.
 * - **Fresh keys only**: Enter/Space/Escape/Tab repeats, and keyup/keypress of a
 *   key that went down before the dialog opened, never reach it.
 * - **Space never presses a button**: Enter and Escape are the answer keys.
 * - **IME**: an Enter or Escape that belongs to a composition reaches no handler.
 */

const ANSWER_KEYS = new Set(["Enter", "Escape", "Tab", " ", "Spacebar"]);

interface GuardEntry {
	el: HTMLElement;
	quietMs: number;
	armed: boolean;
	lastKeyAt: number;
	/** Keys pressed while this dialog was armed; only their keyup/keypress may pass. */
	fresh: Set<string>;
	onEscape?: () => void;
	onKeyActivity?: () => void;
}

const stack: GuardEntry[] = [];
let now: () => number = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Test seam: drive the quiet window with a fake clock. */
export function setDialogKeyboardGuardClock(clock: (() => number) | null): void {
	now = clock ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
}

function keyId(e: KeyboardEvent): string {
	return e.code || e.key;
}

function isSpace(e: KeyboardEvent): boolean {
	return e.key === " " || e.key === "Spacebar" || e.code === "Space";
}

/** A control whose Space activation is a press, not a toggle or text entry. */
function isPressable(target: EventTarget | null): boolean {
	if (!(target instanceof Element)) return false;
	const el = target.closest('button, a[href], [role="button"], input[type="button"], input[type="submit"], input[type="reset"], summary');
	if (!el) return false;
	const role = el.getAttribute("role");
	return role !== "checkbox" && role !== "switch" && role !== "radio" && role !== "option" && role !== "tab" && role !== "menuitemcheckbox";
}

function block(e: KeyboardEvent): void {
	e.preventDefault();
	e.stopImmediatePropagation();
}

function onKey(e: KeyboardEvent): void {
	const top = stack[stack.length - 1];
	if (!top) return;
	const t = now();

	if (e.type === "keydown") {
		if (e.isComposing || e.keyCode === 229) {
			// The composition owns this key; its default (committing the text) stays.
			if (e.key === "Enter" || e.key === "Escape") e.stopImmediatePropagation();
			return;
		}
		if (!top.armed && t - top.lastKeyAt >= top.quietMs) top.armed = true;
		top.lastKeyAt = t;
		top.onKeyActivity?.();
		if (!top.armed) {
			// System combos (⌘Q, ⌘W) are not typing and do not answer the dialog.
			if (!e.metaKey && !e.ctrlKey) block(e);
			return;
		}
		if (e.repeat) {
			// A held Space in a text field keeps typing spaces; on a button it is a press.
			if (isSpace(e) ? isPressable(e.target) : ANSWER_KEYS.has(e.key)) block(e);
			return;
		}
		top.fresh.add(keyId(e));
		if (e.key === "Escape" && top.onEscape) {
			block(e);
			top.onEscape();
			return;
		}
		if (isSpace(e) && isPressable(e.target)) e.preventDefault();
		return;
	}

	const id = keyId(e);
	if (!top.fresh.has(id)) {
		if (ANSWER_KEYS.has(e.key)) block(e);
		return;
	}
	if (isSpace(e) && isPressable(e.target)) e.preventDefault();
	if (e.type === "keyup") top.fresh.delete(id);
}

function onPointerDown(e: Event): void {
	for (const entry of stack) {
		if (e.target instanceof Node && entry.el.contains(e.target)) entry.armed = true;
	}
}

if (typeof window !== "undefined") {
	window.addEventListener("keydown", onKey, true);
	window.addEventListener("keypress", onKey, true);
	window.addEventListener("keyup", onKey, true);
	window.addEventListener("pointerdown", onPointerDown, true);
}

export interface DialogKeyboardGuardOptions {
	/** Silence (ms) the keyboard must keep before keys may answer. 0 = armed at once. */
	quietMs?: number;
	/** Escape on an armed dialog. Topmost-wins: runs before any other Escape handler. */
	onEscape?: () => void;
	/** Every keydown while this dialog is on top, swallowed ones included: someone is at the keyboard. */
	onKeyActivity?: () => void;
}

/** Recommended quiet window for dialogs that open without a user gesture. */
export const UNSOLICITED_DIALOG_QUIET_MS = 700;

/** Guard the dialog element behind `ref` for as long as the component is mounted. */
export function useDialogKeyboardGuard(ref: RefObject<HTMLElement | null>, options: DialogKeyboardGuardOptions = {}): void {
	const onEscape = useRef(options.onEscape);
	onEscape.current = options.onEscape;
	const onKeyActivity = useRef(options.onKeyActivity);
	onKeyActivity.current = options.onKeyActivity;
	const quietMs = options.quietMs ?? 0;
	const hasEscape = Boolean(options.onEscape);

	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const entry: GuardEntry = {
			el,
			quietMs,
			armed: quietMs <= 0,
			lastKeyAt: now(),
			fresh: new Set(),
			...(hasEscape ? { onEscape: () => onEscape.current?.() } : {}),
			onKeyActivity: () => onKeyActivity.current?.(),
		};
		stack.push(entry);
		return () => {
			const i = stack.indexOf(entry);
			if (i >= 0) stack.splice(i, 1);
		};
	}, [ref, quietMs, hasEscape]);
}
