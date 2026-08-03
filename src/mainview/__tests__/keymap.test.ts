import { afterEach, describe, expect, it } from "vitest";
import {
	APP_SHORTCUTS,
	SHORTCUT_CATEGORY_KEY,
	SHORTCUT_CATEGORY_ORDER,
	SHORTCUT_SLOTS,
	appShortcutsForMode,
	bindingsFor,
	findConflict,
	isRemappable,
	matchesShortcut,
	shortcutAppliesInMode,
	shortcutKeysFor,
	shortcutKeysForMode,
	shortcutsInCategory,
	slotBindings,
	slotDefaults,
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
				expect(slotDefaults(s, "primary").length, `${s.id} is remappable but has no primary binding`).toBeGreaterThan(0);
			} else {
				expect(s.display, `${s.id} is fixed but has no display text`).toBeTruthy();
				expect(s.fixedReasonKey, `${s.id} is fixed without saying why`).toBeTruthy();
				expect(en).toHaveProperty(s.fixedReasonKey!);
			}
		}
	});

	it("no two shortcuts ship the same default binding within a conflict group", () => {
		for (const spec of APP_SHORTCUTS) {
			for (const slot of SHORTCUT_SLOTS) {
				for (const binding of slotDefaults(spec, slot)) {
					const clash = findConflict(spec.id, binding);
					expect(
						clash,
						`${spec.id} (${slot}) clashes with ${clash?.ownerId} (${clash?.ownerSlot}) on ${serializeBinding(binding)}`,
					).toBeNull();
				}
			}
		}
	});

	it("an alias only exists where a second combo is genuinely offered", () => {
		const withAlias = APP_SHORTCUTS.filter((s) => slotDefaults(s, "alias").length > 0).map((s) => s.id);
		expect(withAlias).toEqual(["back", "forward", "task-hints", "new-task", "terminal-fullscreen"]);
		// A slot never carries platform variants of its own beyond the primary's.
		for (const s of APP_SHORTCUTS) {
			expect(slotDefaults(s, "alias").length, `${s.id} has more than one alias`).toBeLessThanOrEqual(1);
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

const specFor = (id: string) => APP_SHORTCUTS.find((s) => s.id === id)!;

describe("user overrides", () => {
	it("an override replaces the slot's default wholesale", () => {
		setShortcutOverrides({ "go-to-project": { primary: "Mod+KeyJ" } });
		expect(matchesShortcut(key("KeyJ", { meta: true }), "go-to-project", desktopMac)).toBe(true);
		expect(matchesShortcut(key("KeyK", { meta: true }), "go-to-project", desktopMac)).toBe(false);
		expect(shortcutKeysFor(specFor("go-to-project"), true)).toBe("⌘J");
	});

	it("a nulled slot means deliberately unbound", () => {
		setShortcutOverrides({ "go-to-project": { primary: null } });
		expect(matchesShortcut(key("KeyK", { meta: true }), "go-to-project", desktopMac)).toBe(false);
		expect(bindingsFor(specFor("go-to-project"))).toEqual([]);
	});

	it("an unparsable stored binding is dropped, not fatal", () => {
		setShortcutOverrides({ back: { primary: "Bogus+KeyJ" } });
		// The junk primary empties, the untouched alias keeps firing.
		expect(slotBindings(specFor("back"), "primary")).toEqual([]);
		expect(bindingsFor(specFor("back"))).toEqual([{ code: "Minus", mods: ["Ctrl"] }]);
	});

	it("a fixed shortcut ignores an override that somehow reached the store", () => {
		setShortcutOverrides({ escape: { primary: "Mod+KeyE" } });
		expect(bindingsFor(specFor("escape"))).toEqual([]);
	});

	it("overriding the alias leaves the primary on its default", () => {
		setShortcutOverrides({ back: { alias: "Mod+KeyB" } });
		expect(slotBindings(specFor("back"), "primary")).toEqual(slotDefaults(specFor("back"), "primary"));
		expect(matchesShortcut(key("BracketLeft", { meta: true }), "back", desktopMac)).toBe(true);
		expect(matchesShortcut(key("KeyB", { meta: true }), "back", desktopMac)).toBe(true);
		expect(matchesShortcut(key("Minus", { ctrl: true }), "back", desktopMac)).toBe(false);
	});

	it("overriding the primary leaves the alias on its default", () => {
		setShortcutOverrides({ back: { primary: "Mod+KeyB" } });
		expect(slotBindings(specFor("back"), "alias")).toEqual(slotDefaults(specFor("back"), "alias"));
		expect(matchesShortcut(key("KeyB", { meta: true }), "back", desktopMac)).toBe(true);
		expect(matchesShortcut(key("BracketLeft", { meta: true }), "back", desktopMac)).toBe(false);
		expect(matchesShortcut(key("Minus", { ctrl: true }), "back", desktopMac)).toBe(true);
	});

	it("a nulled slot goes silent while the other slot still fires", () => {
		setShortcutOverrides({ "new-task": { primary: null } });
		expect(matchesShortcut(key("KeyN", { meta: true }), "new-task", desktopMac)).toBe(false);
		expect(matchesShortcut(key("KeyC"), "new-task", desktopMac)).toBe(true);
		expect(shortcutKeysFor(specFor("new-task"), true)).toBe("C");
	});

	it("findConflict sees a rebind, and stays inside the conflict group", () => {
		setShortcutOverrides({ "go-to-project": { primary: "Mod+Comma" } });
		const clash = findConflict("settings", { code: "Comma", mods: ["Mod"] });
		expect(clash?.ownerId).toBe("go-to-project");
		expect(clash?.ownerSlot).toBe("primary");
		// ⌘F is the terminal search and the artifact search at once — different
		// groups, so neither steals from the other.
		expect(findConflict("terminal-search", { code: "KeyF", mods: ["Mod"] })).toBeNull();
	});

	it("findConflict names the alias slot when the alias holds the combo", () => {
		// ⌃- is `back`'s alternative, not its main combo — stealing it must empty
		// only that slot, so the caller has to be told which one it is.
		expect(findConflict("settings", { code: "Minus", mods: ["Ctrl"] })).toEqual({
			ownerId: "back",
			ownerSlot: "alias",
			binding: { code: "Minus", mods: ["Ctrl"] },
		});

		setShortcutOverrides({ "task-hints": { alias: "Mod+KeyJ" } });
		const rebound = findConflict("go-to-project", { code: "KeyJ", mods: ["Mod"] });
		expect(rebound?.ownerId).toBe("task-hints");
		expect(rebound?.ownerSlot).toBe("alias");
	});
});

describe("terminal pane shortcuts", () => {
	const paneIds = ["pane-close", "pane-split-vertical", "pane-split-horizontal", "tmux-new-window"];

	it("are registered as always-on terminal-group shortcuts", () => {
		for (const id of paneIds) {
			const spec = specFor(id);
			expect(spec, `${id} missing from the registry`).toBeTruthy();
			expect(spec.category).toBe("terminal");
			expect(spec.conflictGroup).toBe("terminal");
			expect(isRemappable(spec)).toBe(true);
		}
		expect(shortcutKeysFor(specFor("pane-close"), true)).toBe("⌘W");
		expect(shortcutKeysFor(specFor("pane-split-vertical"), true)).toBe("⌘D");
		expect(shortcutKeysFor(specFor("pane-split-horizontal"), true)).toBe("⇧⌘D");
		expect(shortcutKeysFor(specFor("tmux-new-window"), true)).toBe("⌘T");
	});

	it("do not compete with the app-level combo space", () => {
		// They fire only while a terminal has focus, so an app-group shortcut is
		// free to claim ⌘W / ⌘D / ⌘T without a conflict warning.
		for (const binding of [
			{ code: "KeyW", mods: ["Mod"] as const },
			{ code: "KeyD", mods: ["Mod"] as const },
			{ code: "KeyD", mods: ["Mod", "Shift"] as const },
			{ code: "KeyT", mods: ["Mod"] as const },
		]) {
			expect(
				findConflict("go-to-project", { code: binding.code, mods: [...binding.mods] }),
				`${serializeBinding({ code: binding.code, mods: [...binding.mods] })} leaked into the app group`,
			).toBeNull();
		}
		// Inside the terminal group they still guard each other.
		expect(findConflict("terminal-search", { code: "KeyW", mods: ["Mod"] })?.ownerId).toBe("pane-close");
	});
});
