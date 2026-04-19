import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type {
	ShortcutModifier,
	TasksQuickSwitchShortcut,
	TasksQuickSwitchShortcutModifier,
} from "../shared/types";
import {
	DEFAULT_TASKS_QUICK_SWITCH_SHORTCUT,
	normalizeTasksQuickSwitchShortcutKey,
	tasksQuickSwitchShortcutsEqual,
} from "../shared/types";
import type { TFunction } from "./i18n";

const SHORTCUT_MODIFIER_ORDER: ShortcutModifier[] = [
	"ctrl",
	"alt",
	"shift",
	"meta",
];

export const TASKS_QUICK_SWITCH_SHORTCUT_RECORDER_ATTR =
	"data-tasks-quick-switch-shortcut-recorder";
export const TASKS_QUICK_SWITCH_SHORTCUT_MODAL_ATTR =
	"data-tasks-quick-switch-shortcut-modal";

export const ALT_TAB_QUICK_SWITCH_SHORTCUT: TasksQuickSwitchShortcut = {
	modifiers: ["alt"],
	key: "Tab",
};

export const CTRL_TAB_QUICK_SWITCH_SHORTCUT: TasksQuickSwitchShortcut = {
	modifiers: ["ctrl"],
	key: "Tab",
};

function getShortcutModifiersFromKeyboardEvent(
	event: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey">,
): ShortcutModifier[] {
	return SHORTCUT_MODIFIER_ORDER.filter((modifier) => {
		switch (modifier) {
			case "ctrl":
				return event.ctrlKey;
			case "alt":
				return event.altKey;
			case "shift":
				return event.shiftKey;
			case "meta":
				return event.metaKey;
		}
	});
}

function getCanonicalShortcutKeyFromCode(
	code: string | null | undefined,
): string | null {
	if (typeof code !== "string") {
		return null;
	}
	const keyMatch = /^Key([A-Z])$/.exec(code);
	if (keyMatch) {
		return keyMatch[1];
	}
	const digitMatch = /^Digit([0-9])$/.exec(code);
	if (digitMatch) {
		return digitMatch[1];
	}
	return null;
}

function getCanonicalShortcutKeyFromEvent(
	event: Pick<KeyboardEvent, "key" | "code">,
): string | null {
	return (
		getCanonicalShortcutKeyFromCode(event.code) ??
		normalizeTasksQuickSwitchShortcutKey(event.key)
	);
}

function formatShortcutModifier(
	modifier: ShortcutModifier,
	t: TFunction,
): string {
	switch (modifier) {
		case "ctrl":
			return t("quickSwitch.shortcutCtrl");
		case "alt":
			return t("quickSwitch.shortcutAlt");
		case "shift":
			return t("quickSwitch.shortcutShift");
		case "meta":
			return t("quickSwitch.shortcutMeta");
	}
}

function formatShortcutKey(key: string, t: TFunction): string {
	switch (key) {
		case "Tab":
			return t("quickSwitch.keyTab");
		case "Space":
			return t("quickSwitch.keySpace");
		case "ArrowUp":
			return t("quickSwitch.keyArrowUp");
		case "ArrowDown":
			return t("quickSwitch.keyArrowDown");
		case "ArrowLeft":
			return t("quickSwitch.keyArrowLeft");
		case "ArrowRight":
			return t("quickSwitch.keyArrowRight");
		default:
			return key;
	}
}

export function formatTasksQuickSwitchShortcut(
	shortcut: TasksQuickSwitchShortcut,
	t: TFunction,
): string {
	return [
		...shortcut.modifiers.map((modifier) =>
			formatShortcutModifier(modifier, t),
		),
		formatShortcutKey(shortcut.key, t),
	].join(" + ");
}

export function formatTasksQuickSwitchShortcutModifiers(
	shortcut: TasksQuickSwitchShortcut,
	t: TFunction,
): string {
	if (shortcut.modifiers.length === 0) {
		return formatTasksQuickSwitchShortcut(DEFAULT_TASKS_QUICK_SWITCH_SHORTCUT, t);
	}
	return shortcut.modifiers
		.map((modifier) => formatShortcutModifier(modifier, t))
		.join(" + ");
}

export function isPresetTasksQuickSwitchShortcut(
	shortcut: TasksQuickSwitchShortcut,
	modifier: TasksQuickSwitchShortcutModifier,
): boolean {
	return tasksQuickSwitchShortcutsEqual(
		shortcut,
		modifier === "ctrl"
			? CTRL_TAB_QUICK_SWITCH_SHORTCUT
			: ALT_TAB_QUICK_SWITCH_SHORTCUT,
	);
}

export function isQuickSwitchShortcutPressed(
	event: KeyboardEvent,
	shortcut: TasksQuickSwitchShortcut,
): boolean {
	const eventKey = getCanonicalShortcutKeyFromEvent(event);
	if (eventKey !== shortcut.key) {
		return false;
	}
	// If Shift isn't part of the shortcut itself, treat an extra Shift press
	// as a direction indicator (macOS Cmd+Tab convention) rather than a mismatch.
	// getQuickSwitchDirection reads the shift flag to decide forward vs backward.
	const shortcutIncludesShift = shortcut.modifiers.includes("shift");
	const eventModifiers = getShortcutModifiersFromKeyboardEvent(event).filter(
		(modifier) => shortcutIncludesShift || modifier !== "shift",
	);
	if (eventModifiers.length !== shortcut.modifiers.length) {
		return false;
	}
	return shortcut.modifiers.every(
		(modifier, index) => modifier === eventModifiers[index],
	);
}

export function areQuickSwitchShortcutModifiersStillPressed(
	event: KeyboardEvent,
	shortcut: TasksQuickSwitchShortcut,
): boolean {
	if (shortcut.modifiers.length === 0) {
		return false;
	}
	return shortcut.modifiers.every((modifier) => {
		switch (modifier) {
			case "ctrl":
				return event.ctrlKey;
			case "alt":
				return event.altKey;
			case "shift":
				return event.shiftKey;
			case "meta":
				return event.metaKey;
		}
	});
}

export function getTasksQuickSwitchShortcutFromKeyboardEvent(
	event: KeyboardEvent | ReactKeyboardEvent<HTMLElement>,
): TasksQuickSwitchShortcut | null {
	const key = getCanonicalShortcutKeyFromEvent(event);
	if (!key) {
		return null;
	}
	const modifiers = getShortcutModifiersFromKeyboardEvent(event);
	if (modifiers.length === 0) {
		return null;
	}
	return {
		modifiers,
		key,
	};
}

export function isTasksQuickSwitchShortcutModalOpen(): boolean {
	if (typeof document === "undefined") {
		return false;
	}
	return (
		document.querySelector(
			`[${TASKS_QUICK_SWITCH_SHORTCUT_MODAL_ATTR}="true"]`,
		) !== null
	);
}
