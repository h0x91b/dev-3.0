import { describe, expect, it } from "vitest";
import {
	APP_SHORTCUTS,
	SHORTCUT_CATEGORY_KEY,
	SHORTCUT_CATEGORY_ORDER,
	appShortcutsForMode,
	shortcutAppliesInMode,
	shortcutKeysFor,
	shortcutKeysForMode,
	shortcutsInCategory,
} from "../keymap";
import en from "../i18n/translations/en";

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

	it("every shortcut has non-empty per-platform key strings", () => {
		for (const s of APP_SHORTCUTS) {
			expect(s.keys.mac.length, `empty mac keys for ${s.id}`).toBeGreaterThan(0);
			expect(s.keys.other.length, `empty other keys for ${s.id}`).toBeGreaterThan(0);
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
		expect(APP_SHORTCUTS.find((s) => s.id === "back")?.keys).toEqual({
			mac: "⌘[ / Ctrl+-",
			other: "Ctrl+[ / Ctrl+-",
		});
		expect(APP_SHORTCUTS.find((s) => s.id === "forward")?.keys).toEqual({
			mac: "⌘] / Ctrl+Shift+-",
			other: "Ctrl+] / Ctrl+Shift+-",
		});
	});

	it("keeps zoom-out distinct from the Ctrl-minus navigation alias", () => {
		expect(APP_SHORTCUTS.find((s) => s.id === "zoom-out")?.keys).toEqual({
			mac: "⌘-",
			other: "Ctrl+Alt+-",
		});
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

	it("every remoteKeys override has non-empty per-platform strings", () => {
		for (const s of APP_SHORTCUTS) {
			if (!s.remoteKeys) continue;
			expect(s.remoteKeys.mac.length, `empty remote mac keys for ${s.id}`).toBeGreaterThan(0);
			expect(s.remoteKeys.other.length, `empty remote other keys for ${s.id}`).toBeGreaterThan(0);
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

	it("appShortcutsForMode(remote) excludes every desktop-only shortcut", () => {
		const remote = appShortcutsForMode(true);
		const ids = remote.map((s) => s.id);
		for (const id of ["quit", "hide", "new-window", "zoom-in", "zoom-out", "zoom-reset", "hard-refresh"]) {
			expect(ids, `${id} should be hidden in remote`).not.toContain(id);
		}
		// Desktop keeps them all.
		expect(appShortcutsForMode(false).length).toBe(APP_SHORTCUTS.length);
		expect(remote.length).toBeLessThan(APP_SHORTCUTS.length);
	});

	it("shortcutKeysForMode applies remoteKeys only in remote mode", () => {
		const switchProject = APP_SHORTCUTS.find((s) => s.id === "switch-project")!;
		expect(shortcutKeysForMode(switchProject, true, false)).toBe("⌘1–9"); // desktop
		expect(shortcutKeysForMode(switchProject, true, true)).toBe("G then 1–9"); // remote alias
		// A shortcut without remoteKeys is unchanged across modes.
		const palette = APP_SHORTCUTS.find((s) => s.id === "command-palette")!;
		expect(shortcutKeysForMode(palette, true, true)).toBe(shortcutKeysForMode(palette, true, false));
	});
});
