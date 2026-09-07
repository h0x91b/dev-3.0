/**
 * In-page anchors inside an artifact.
 *
 * External links are handled by the frame itself: `<base target="_blank">` plus
 * `allow-popups` on the sandbox (see `ArtifactFrame.tsx`). That default catches
 * `#section` too, and a `srcdoc` document's base URL is the PARENT page's URL —
 * so an anchor click opened a new tab showing the app instead of scrolling.
 * Measured in a real sandboxed frame; see
 * `decisions/2026/09/07/artifact-links-open-in-the-browser.md`.
 *
 * Same authoring rule as the channel and the bridge: a real function, serialized
 * by {@link artifactLinksScript}, so it may reference nothing outside its own
 * body except the argument it is handed.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function installArtifactLinks(win: any): void {
	const doc = win && win.document;
	if (!doc || !doc.addEventListener) return;

	doc.addEventListener("click", function (event: { defaultPrevented?: boolean; target?: any; preventDefault(): void }) {
		if (event.defaultPrevented) return;
		const anchor = event.target && event.target.closest ? event.target.closest('a[href^="#"]') : null;
		if (!anchor) return;
		event.preventDefault();
		const id = anchor.getAttribute("href").slice(1);
		if (!id) {
			win.scrollTo(0, 0);
			return;
		}
		let decoded = id;
		try {
			decoded = decodeURIComponent(id);
		} catch (_err) {
			decoded = id;
		}
		const target = doc.getElementById(decoded) || doc.getElementById(id)
			|| (doc.getElementsByName ? doc.getElementsByName(decoded)[0] : null);
		if (target && target.scrollIntoView) target.scrollIntoView({ block: "start", behavior: "smooth" });
	}, true);
}

/** The injected `<script>` that keeps in-page anchors scrolling this document. */
export function artifactLinksScript(): string {
	return `<script data-dev3-artifact-links>(${installArtifactLinks.toString()})(window);</script>`;
}
