import { afterEach, describe, expect, it } from "vitest";
import { initThemeColorSync } from "../theme-color";

describe("initThemeColorSync", () => {
	afterEach(() => {
		document.head.innerHTML = "";
		document.documentElement.removeAttribute("style");
		delete document.documentElement.dataset.theme;
	});

	it("follows --surface-base when data-theme flips", async () => {
		document.head.innerHTML = '<meta name="theme-color" content="#000000">';
		const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!;
		const root = document.documentElement;
		root.style.setProperty("--surface-base", "6 9 22");

		initThemeColorSync(root);
		expect(meta.content).toBe("rgb(6, 9, 22)");

		root.style.setProperty("--surface-base", "235 239 250");
		root.dataset.theme = "light";
		await new Promise((r) => setTimeout(r, 0));
		expect(meta.content).toBe("rgb(235, 239, 250)");
	});

	it("does nothing without the meta tag", () => {
		expect(() => initThemeColorSync()).not.toThrow();
	});
});
