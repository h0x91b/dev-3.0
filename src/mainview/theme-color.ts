/** Keeps `<meta name="theme-color">` on the active theme's `--surface-base`, so iOS Safari
 * paints its status bar to match the app instead of a light default. */
export function initThemeColorSync(root: HTMLElement = document.documentElement): void {
	const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
	if (!meta) return;
	const sync = () => {
		const base = getComputedStyle(root).getPropertyValue("--surface-base").trim();
		if (base) meta.content = `rgb(${base.split(/\s+/).join(", ")})`;
	};
	sync();
	new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
}
