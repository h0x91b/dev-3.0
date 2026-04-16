import { describe, expect, it } from "vitest";
import { getInitialThemeState } from "../theme-bootstrap";

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
});
