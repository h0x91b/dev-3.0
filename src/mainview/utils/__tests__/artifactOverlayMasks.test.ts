import {
	ARTIFACT_OVERLAY_ATTRIBUTE,
	OVERLAY_MASK_ATTRIBUTE,
	clearOverlayMaskTags,
	syncOverlayMaskTags,
} from "../artifactOverlayMasks";

function rect(el: HTMLElement, left: number, top: number, width: number, height: number): void {
	el.getBoundingClientRect = () => ({
		left, top, width, height, right: left + width, bottom: top + height, x: left, y: top,
		toJSON: () => ({}),
	}) as DOMRect;
}

function fixedBox(id: string, left: number, top: number, width: number, height: number): HTMLElement {
	const el = document.createElement("div");
	el.id = id;
	el.className = "fixed";
	el.style.position = "fixed";
	rect(el, left, top, width, height);
	document.body.appendChild(el);
	return el;
}

let host: HTMLElement;

beforeEach(() => {
	document.body.innerHTML = "";
	const viewer = document.createElement("section");
	host = document.createElement("div");
	viewer.appendChild(host);
	document.body.appendChild(viewer);
	rect(viewer, 400, 0, 600, 800);
	rect(host, 400, 100, 600, 700);
});

describe("overlay mask tags", () => {
	it("tags a fixed overlay that covers the artifact and leaves the rest alone", () => {
		const toast = fixedBox("toast", 700, 120, 260, 80);
		const elsewhere = fixedBox("elsewhere", 0, 0, 100, 40);

		const signature = syncOverlayMaskTags(host);

		expect(toast.hasAttribute(OVERLAY_MASK_ATTRIBUTE)).toBe(true);
		expect(elsewhere.hasAttribute(OVERLAY_MASK_ATTRIBUTE)).toBe(false);
		expect(signature).toBe("700,120,260,80");
	});

	it("never masks an ancestor of the artifact — the fullscreen viewer is fixed too", () => {
		const fullscreen = document.createElement("div");
		fullscreen.className = "fixed";
		fullscreen.style.position = "fixed";
		rect(fullscreen, 0, 0, 1400, 900);
		document.body.appendChild(fullscreen);
		fullscreen.appendChild(host);

		expect(syncOverlayMaskTags(host)).toBe("");
		expect(fullscreen.hasAttribute(OVERLAY_MASK_ATTRIBUTE)).toBe(false);
	});

	it("untags an overlay that moved off the artifact, and says so in the signature", () => {
		const toast = fixedBox("toast", 700, 120, 260, 80);
		const before = syncOverlayMaskTags(host);

		rect(toast, 0, 0, 260, 80);
		const after = syncOverlayMaskTags(host);

		expect(toast.hasAttribute(OVERLAY_MASK_ATTRIBUTE)).toBe(false);
		expect(after).not.toBe(before);
		expect(after).toBe("");
	});

	it("ignores a fixed element that is laid out to nothing or made invisible", () => {
		const collapsed = fixedBox("collapsed", 700, 120, 0, 0);
		const invisible = fixedBox("invisible", 700, 120, 200, 60);
		invisible.style.visibility = "hidden";

		expect(syncOverlayMaskTags(host)).toBe("");
		expect(collapsed.hasAttribute(OVERLAY_MASK_ATTRIBUTE)).toBe(false);
		expect(invisible.hasAttribute(OVERLAY_MASK_ATTRIBUTE)).toBe(false);
	});

	// The find bar sits inside the viewer and is absolutely positioned, so the
	// fixed-element scan cannot see it — it carries the attribute itself.
	it("counts hand-tagged in-viewer chrome without needing it to be fixed", () => {
		const bar = document.createElement("div");
		bar.setAttribute(ARTIFACT_OVERLAY_ATTRIBUTE, "");
		rect(bar, 820, 110, 160, 32);
		host.appendChild(bar);

		expect(syncOverlayMaskTags(host)).toBe("a820,110,160,32");
	});

	it("reports nothing while the artifact itself is laid out to zero", () => {
		fixedBox("toast", 700, 120, 260, 80);
		rect(host, 0, 0, 0, 0);
		expect(syncOverlayMaskTags(host)).toBe("");
	});

	it("clears every tag it placed when the viewer goes away", () => {
		const toast = fixedBox("toast", 700, 120, 260, 80);
		syncOverlayMaskTags(host);
		clearOverlayMaskTags();
		expect(toast.hasAttribute(OVERLAY_MASK_ATTRIBUTE)).toBe(false);
	});
});
