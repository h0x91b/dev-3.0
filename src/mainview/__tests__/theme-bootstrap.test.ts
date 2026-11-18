import { describe, expect, it } from "vitest";
import { applyBeigeDepth, applyThemeToDocument, getInitialThemeState, readBeigeDepth } from "../theme-bootstrap";

describe("getInitialThemeState", () => {
	it("uses the injected remote theme when browser storage is empty", () => {
		expect(
			getInitialThemeState({
				localStorageTheme: null,
				injectedTheme: "light",
				injectedResolvedTheme: "light",
				prefersDark: true,
			}),
		).toEqual({
			preference: "light",
			resolved: "light",
		});
	});

	it("prefers the injected remote theme over stale browser storage", () => {
		expect(
			getInitialThemeState({
				localStorageTheme: "dark",
				injectedTheme: "light",
				injectedResolvedTheme: "light",
				prefersDark: false,
			}),
		).toEqual({
			preference: "light",
			resolved: "light",
		});
	});

	it("uses the injected resolved theme for system preference", () => {
		expect(
			getInitialThemeState({
				localStorageTheme: null,
				injectedTheme: "system",
				injectedResolvedTheme: "light",
				prefersDark: true,
			}),
		).toEqual({
			preference: "system",
			resolved: "light",
		});
	});

	it("falls back to localStorage after injected state is cleared (OS theme change scenario)", () => {
		// Simulates what happens when the user manually picks a theme after remote page load,
		// then the OS switches modes. By that point injectedTheme has been consumed (set to
		// undefined) so localStorage must win — otherwise the user's choice gets overwritten.
		expect(
			getInitialThemeState({
				localStorageTheme: "dark",
				injectedTheme: undefined,
				injectedResolvedTheme: undefined,
				prefersDark: true,
			}),
		).toEqual({
			preference: "dark",
			resolved: "dark",
		});
	});

	it("resolves beige to the light theme", () => {
		expect(
			getInitialThemeState({ localStorageTheme: "beige", prefersDark: true }),
		).toEqual({ preference: "beige", resolved: "light" });
	});
});

describe("applyThemeToDocument", () => {
	it("sets the beige palette and clears it when leaving beige", () => {
		const root = document.documentElement;
		applyThemeToDocument("beige", "light");
		expect(root.dataset.theme).toBe("light");
		expect(root.dataset.palette).toBe("beige");
		applyThemeToDocument("light", "light");
		expect(root.dataset.palette).toBeUndefined();
	});
});

describe("applyBeigeDepth", () => {
	it("writes depth-driven tokens scoped to the beige palette and remembers the depth", () => {
		applyBeigeDepth(1);
		const css = document.getElementById("dev3-beige-depth")?.textContent ?? "";
		expect(css).toContain('[data-theme="light"][data-palette="beige"]');
		expect(css).toContain("--surface-base: 206 190 162;");
		expect(document.documentElement.dataset.beigeDepth).toBe("1");
		expect(readBeigeDepth()).toBe(1);
		applyBeigeDepth(7);
		expect(readBeigeDepth()).toBe(1);
	});
});
