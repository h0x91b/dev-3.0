/**
 * Keeping app overlays visible over the artifact webview.
 *
 * An `<electrobun-webview>` is not part of the page: it is a native view the OS
 * paints above the whole window, so CSS `z-index`, `overflow` and stacking order
 * mean nothing to it. A modal, a toast or a dropdown drawn "on top" of the viewer
 * would be painted underneath the native layer and simply not be there.
 *
 * The tag's answer is masks — rectangles punched out of the native view so the
 * host page shows through. Which rectangles is decided here, at runtime, rather
 * than by tagging two dozen modal components by hand: an overlay that nobody
 * remembered to tag is exactly the bug this has to not have.
 *
 * Anything that must stay visible over the artifact and is NOT a fixed-position
 * element (the viewer's own find bar, which is absolutely positioned inside the
 * viewer) carries {@link ARTIFACT_OVERLAY_ATTRIBUTE} instead.
 */

/** Set by {@link syncOverlayMaskTags} on fixed overlays that cover the artifact. */
export const OVERLAY_MASK_ATTRIBUTE = "data-dev3-overlay";
/** Hand-placed on in-viewer chrome that must punch through the native layer. */
export const ARTIFACT_OVERLAY_ATTRIBUTE = "data-dev3-artifact-overlay";

export const ARTIFACT_MASK_SELECTORS = [
	`[${OVERLAY_MASK_ATTRIBUTE}]`,
	`[${ARTIFACT_OVERLAY_ATTRIBUTE}]`,
];

export interface MaskCandidateRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

function intersects(a: MaskCandidateRect, b: MaskCandidateRect): boolean {
	return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * Tag every fixed-position element that currently covers `host`, untag the rest,
 * and return a signature of what is tagged and where.
 *
 * The signature exists because the tag only re-sends its masks when its OWN rect
 * changes — an overlay opening while the viewer sits still would otherwise never
 * reach it. The caller compares signatures and forces a sync when they differ.
 */
export function syncOverlayMaskTags(host: HTMLElement, doc: Document = document): string {
	const hostRect = host.getBoundingClientRect();
	if (hostRect.width === 0 || hostRect.height === 0) return "";

	// `.fixed` is the Tailwind class every overlay in this app uses, whether it is
	// portalled to <body> or rendered in place; body children cover the handful
	// that position themselves with an inline style instead.
	const candidates = new Set<Element>([
		...Array.from(doc.querySelectorAll(".fixed")),
		...Array.from(doc.body?.children ?? []),
	]);

	const parts: string[] = [];
	for (const element of candidates) {
		if (!(element instanceof HTMLElement)) continue;
		// The viewer itself goes fullscreen as a fixed element, and it is the thing
		// the webview lives inside — masking it would punch a hole through everything.
		if (element.contains(host)) continue;
		const style = doc.defaultView?.getComputedStyle(element);
		const rect = element.getBoundingClientRect();
		const covering = style?.position === "fixed"
			&& style.visibility !== "hidden"
			&& rect.width > 0
			&& rect.height > 0
			&& intersects(rect, hostRect);
		if (covering) {
			element.setAttribute(OVERLAY_MASK_ATTRIBUTE, "");
			parts.push(`${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)}`);
		} else if (element.hasAttribute(OVERLAY_MASK_ATTRIBUTE)) {
			element.removeAttribute(OVERLAY_MASK_ATTRIBUTE);
		}
	}

	for (const element of doc.querySelectorAll(`[${ARTIFACT_OVERLAY_ATTRIBUTE}]`)) {
		const rect = element.getBoundingClientRect();
		parts.push(`a${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)}`);
	}

	parts.sort();
	return parts.join("|");
}

/** Drop every tag this module placed — the viewer is going away. */
export function clearOverlayMaskTags(doc: Document = document): void {
	for (const element of doc.querySelectorAll(`[${OVERLAY_MASK_ATTRIBUTE}]`)) {
		element.removeAttribute(OVERLAY_MASK_ATTRIBUTE);
	}
}
