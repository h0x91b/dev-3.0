import { describe, expect, it } from "vitest";
import {
	APP_SHORTCUTS,
	SHORTCUT_CATEGORY_KEY,
	SHORTCUT_CATEGORY_ORDER,
	shortcutKeysFor,
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

	it("shortcutsInCategory returns only that category, in registry order", () => {
		const nav = shortcutsInCategory("navigation");
		expect(nav.length).toBeGreaterThan(0);
		expect(nav.every((s) => s.category === "navigation")).toBe(true);
		expect(nav[0].id).toBe("go-to-project");
	});
});
