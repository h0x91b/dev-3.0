import { afterEach, describe, expect, it } from "vitest";
import {
	APP_SHORTCUTS,
	SHORTCUT_CATEGORY_KEY,
	SHORTCUT_CATEGORY_ORDER,
	appShortcutsForMode,
	bindingsFor,
	findConflict,
	isRemappable,
	matchesShortcut,
	shortcutAppliesInMode,
	shortcutKeysFor,
	shortcutKeysForMode,
	shortcutsInCategory,
} from "../keymap";
import { serializeBinding } from "../keymap-bindings";
import { setShortcutOverrides } from "../keymap-store";
import en from "../i18n/translations/en";

afterEach(() => setShortcutOverrides({}));

/** A minimal keydown stand-in — the matcher only reads these fields. */
function key(
	code: string,
	mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {},
): KeyboardEvent {
	return {
		code,
		key: "",
		metaKey: !!mods.meta,
		ctrlKey: !!mods.ctrl,
		shiftKey: !!mods.shift,
		altKey: !!mods.alt,
	} as KeyboardEvent;
}

const desktopMac = { mac: true, remote: false, typing: false };

describe("keymap registry", () => {
	it("has unique shortcut ids", () => {
		const ids = APP_SHORTCUTS.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("every shortcut has a valid i18n description key", () => {
		for (const s of APP_SHORTCUTS) {
			expect(en, `missing description for ${s.id}`).toHaveProperty(s.descKey);
		}
	});

	it("every shortcut renders a non-empty combo on both platforms", () => {
		for (const s of APP_SHORTCUTS) {
			expect(shortcutKeysFor(s, true).length, `empty mac combo for ${s.id}`).toBeGreaterThan(0);
			expect(shortcutKeysFor(s, false).length, `empty other combo for ${s.id}`).toBeGreaterThan(0);
		}
	});

	it("a remappable shortcut has bindings and a fixed one has a stated reason", () => {
		for (const s of APP_SHORTCUTS) {
			if (isRemappable(s)) {
				expect(s.defaults.length, `${s.id} is remappable but has no default binding`).toBeGreaterThan(0);
			} else {
				expect(s.display, `${s.id} is fixed but has no display text`).toBeTruthy();
				expect(s.fixedReasonKey, `${s.id} is fixed without saying why`).toBeTruthy();
				expect(en).toHaveProperty(s.fixedReasonKey!);
			}
		}
	});

	it("no two shortcuts ship the same default binding within a conflict group", () => {
		for (const spec of APP_SHORTCUTS) {
			for (const binding of spec.defaults) {
				const clash = findConflict(spec.id, binding);
				expect(clash, `${spec.id} clashes with ${clash?.ownerId} on ${serializeBinding(binding)}`).toBeNull();
			}
		}
	});

	it("every category used by a shortcut is in the display order and has a label key", () => {
		for (const s of APP_SHORTCUTS) {
			expect(SHORTCUT_CATEGORY_ORDER).toContain(s.category);
			expect(en).toHaveProperty(SHORTCUT_CATEGORY_KEY[s.category]);
		}
	});

	it("shortcutKeysFor picks the platform-appropriate combo", () => {
		const spec = APP_SHORTCUTS.find((s) => s.id === "go-to-project")!;
		expect(shortcutKeysFor(spec, true)).toBe("⌘K");
		expect(shortcutKeysFor(spec, false)).toBe("Ctrl+K");
	});

	it("documents both route-history shortcut aliases", () => {
		expect(shortcutKeysFor(APP_SHORTCUTS.find((s) => s.id === "back")!, true)).toBe("⌘[ / ⌃-");
		expect(shortcutKeysFor(APP_SHORTCUTS.find((s) => s.id === "forward")!, true)).toBe("⌘] / ⌃⇧-");
	});

	it("keeps zoom-out distinct from the Ctrl-minus navigation alias", () => {
		const zoomOut = APP_SHORTCUTS.find((s) => s.id === "zoom-out")!;
		expect(shortcutKeysFor(zoomOut, true)).toBe("⌘-");
		expect(shortcutKeysFor(zoomOut, false)).toBe("Ctrl+Alt+-");
	});

	it("shortcutsInCategory returns only that category, in registry order", () => {
		const nav = shortcutsInCategory("navigation");
		expect(nav.length).toBeGreaterThan(0);
		expect(nav.every((s) => s.category === "navigation")).toBe(true);
		expect(nav[0].id).toBe("go-to-project");
	});

	it("only valid scopes are used", () => {
		for (const s of APP_SHORTCUTS) {
			expect(["both", "desktop", "remote", undefined]).toContain(s.scope);
		}
	});
});

describe("transport-aware keymap", () => {
	it("shortcutAppliesInMode keeps `both`, drops `desktop` in remote", () => {
		const both = APP_SHORTCUTS.find((s) => s.id === "go-to-project")!;
		const desktopOnly = APP_SHORTCUTS.find((s) => s.id === "quit")!;
		expect(shortcutAppliesInMode(both, false)).toBe(true);
		expect(shortcutAppliesInMode(both, true)).toBe(true);
		expect(shortcutAppliesInMode(desktopOnly, false)).toBe(true);
		expect(shortcutAppliesInMode(desktopOnly, true)).toBe(false);
	});

	it("open-in yields to the browser in remote mode (desktop-scoped)", () => {
		// Cmd/Ctrl+O is the browser's native Open-File dialog, so the app-level
		// shortcut must not apply in remote — it opens an app on the host the
		// remote user can't see.
		const openIn = APP_SHORTCUTS.find((s) => s.id === "open-in")!;
		expect(openIn.scope).toBe("desktop");
		expect(appShortcutsForMode(true).map((s) => s.id)).not.toContain("open-in");
		expect(matchesShortcut(key("KeyO", { meta: true }), "open-in", { ...desktopMac, remote: true })).toBe(false);
	});

	it("appShortcutsForMode(remote) excludes every desktop-only shortcut", () => {
		const remote = appShortcutsForMode(true);
		const ids = remote.map((s) => s.id);
		for (const id of ["quit", "hide", "new-window", "zoom-in", "zoom-out", "zoom-reset", "hard-refresh", "open-in"]) {
			expect(ids, `${id} should be hidden in remote`).not.toContain(id);
		}
		expect(appShortcutsForMode(false).length).toBe(APP_SHORTCUTS.length);
		expect(remote.length).toBeLessThan(APP_SHORTCUTS.length);
	});

	it("shortcutKeysForMode applies the remote display only in remote mode", () => {
		const switchProject = APP_SHORTCUTS.find((s) => s.id === "switch-project")!;
		expect(shortcutKeysForMode(switchProject, true, false)).toBe("⌘1–9");
		expect(shortcutKeysForMode(switchProject, true, true)).toBe("G then 1–9");
		const palette = APP_SHORTCUTS.find((s) => s.id === "command-palette")!;
		expect(shortcutKeysForMode(palette, true, true)).toBe(shortcutKeysForMode(palette, true, false));
	});

	it("drops a browser-owned binding from the remote combo but keeps its sibling", () => {
		// ⌘N opens a browser window that we cannot cancel, so remote falls back to `C`.
		const newTask = APP_SHORTCUTS.find((s) => s.id === "new-task")!;
		expect(shortcutKeysForMode(newTask, true, false)).toBe("⌘N / C");
		expect(shortcutKeysForMode(newTask, true, true)).toBe("C");
		expect(matchesShortcut(key("KeyN", { meta: true }), "new-task", { ...desktopMac, remote: true })).toBe(false);
		expect(matchesShortcut(key("KeyC"), "new-task", { ...desktopMac, remote: true })).toBe(true);
	});
});

describe("matchesShortcut", () => {
	it("matches the platform modifier exactly, not either one", () => {
		expect(matchesShortcut(key("KeyK", { meta: true }), "go-to-project", desktopMac)).toBe(true);
		// ⌃K is kill-to-end-of-line in the shell — it must reach the terminal.
		expect(matchesShortcut(key("KeyK", { ctrl: true }), "go-to-project", desktopMac)).toBe(false);
		// On Linux the same registry entry means Ctrl.
		expect(matchesShortcut(key("KeyK", { ctrl: true }), "go-to-project", { ...desktopMac, mac: false })).toBe(true);
	});

	it("keeps a combo and its Shift sibling apart", () => {
		expect(matchesShortcut(key("BracketLeft", { meta: true }), "back", desktopMac)).toBe(true);
		expect(matchesShortcut(key("BracketLeft", { meta: true }), "previous-variant", desktopMac)).toBe(false);
		expect(matchesShortcut(key("BracketLeft", { meta: true, shift: true }), "previous-variant", desktopMac)).toBe(true);
		expect(matchesShortcut(key("BracketLeft", { meta: true, shift: true }), "back", desktopMac)).toBe(false);
	});

	it("suppresses bare-key bindings while typing, but not modifier combos", () => {
		expect(matchesShortcut(key("KeyC"), "new-task", desktopMac)).toBe(true);
		expect(matchesShortcut(key("KeyC"), "new-task", { ...desktopMac, typing: true })).toBe(false);
		expect(matchesShortcut(key("KeyN", { meta: true }), "new-task", { ...desktopMac, typing: true })).toBe(true);
	});

	it("honours the platform field on a default binding", () => {
		expect(matchesShortcut(key("Minus", { meta: true }), "zoom-out", desktopMac)).toBe(true);
		expect(matchesShortcut(key("Minus", { ctrl: true, alt: true }), "zoom-out", desktopMac)).toBe(false);
		expect(
			matchesShortcut(key("Minus", { ctrl: true, alt: true }), "zoom-out", { ...desktopMac, mac: false }),
		).toBe(true);
	});

	it("an unknown id never matches", () => {
		expect(matchesShortcut(key("KeyK", { meta: true }), "no-such-shortcut", desktopMac)).toBe(false);
	});
});

describe("user overrides", () => {
	it("an override replaces the defaults wholesale", () => {
		setShortcutOverrides({ "go-to-project": ["Mod+KeyJ"] });
		expect(matchesShortcut(key("KeyJ", { meta: true }), "go-to-project", desktopMac)).toBe(true);
		expect(matchesShortcut(key("KeyK", { meta: true }), "go-to-project", desktopMac)).toBe(false);
		expect(shortcutKeysFor(APP_SHORTCUTS.find((s) => s.id === "go-to-project")!, true)).toBe("⌘J");
	});

	it("an empty override means deliberately unbound", () => {
		setShortcutOverrides({ "go-to-project": [] });
		expect(matchesShortcut(key("KeyK", { meta: true }), "go-to-project", desktopMac)).toBe(false);
		expect(bindingsFor(APP_SHORTCUTS.find((s) => s.id === "go-to-project")!)).toEqual([]);
	});

	it("an unparsable stored binding is dropped, not fatal", () => {
		setShortcutOverrides({ "go-to-project": ["Bogus+KeyJ", "Mod+KeyJ"] });
		expect(bindingsFor(APP_SHORTCUTS.find((s) => s.id === "go-to-project")!)).toEqual([
			{ code: "KeyJ", mods: ["Mod"] },
		]);
	});

	it("a fixed shortcut ignores an override that somehow reached the store", () => {
		setShortcutOverrides({ escape: ["Mod+KeyE"] });
		expect(bindingsFor(APP_SHORTCUTS.find((s) => s.id === "escape")!)).toEqual([]);
	});

	it("findConflict sees a rebind, and stays inside the conflict group", () => {
		setShortcutOverrides({ "go-to-project": ["Mod+Comma"] });
		expect(findConflict("settings", { code: "Comma", mods: ["Mod"] })?.ownerId).toBe("go-to-project");
		// ⌘F is the terminal search and the artifact search at once — different
		// groups, so neither steals from the other.
		expect(findConflict("terminal-search", { code: "KeyF", mods: ["Mod"] })).toBeNull();
	});
});
