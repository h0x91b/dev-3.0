/**
 * Comment mode inside an artifact document: pick an element, draw the pins.
 *
 * Injected by the viewer next to the find and save-image scripts. Everything
 * happens inside the sandboxed frame — the viewer only ever learns "the user
 * clicked this element" (`dev3-artifact-comment-pick`) and answers with the list
 * of pins to draw (`dev3-artifact-comment-pins`). Pins are positioned here, not
 * by the parent: the frame knows its own scroll and layout, the parent cannot
 * see either.
 *
 * Authored as a real function and serialized with `toString()`, so it may
 * reference nothing outside its own body except the argument it is handed.
 */

export interface ArtifactCommentPin {
	id: string;
	/** 1-based number shown on the pin. */
	n: number;
	selector: string;
	text: string;
	heading: string | null;
	resolved: boolean;
	active: boolean;
}

export interface ArtifactCommentPick {
	selector: string;
	text: string;
	heading: string | null;
}

export const ARTIFACT_COMMENT_TEXT_LIMIT = 200;

export interface ArtifactCommentToolsConfig {
	textLimit: number;
}

/** Marker attribute on every node this script owns, so a pick never lands on a pin. */
export const ARTIFACT_COMMENT_OWNED_ATTR = "data-dev3-artifact-comment";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function installArtifactCommentTools(win: any, config: ArtifactCommentToolsConfig): void {
	var w = win;
	var doc = w.document;
	var channel = w.__dev3ArtifactChannel;
	if (!doc || !channel) return;
	var OWNED = "data-dev3-artifact-comment";
	var TEXT_LIMIT = config.textLimit;
	var modeOn = false;
	var hoverBox: any = null;
	var pinLayer: any = null;
	var pins: ArtifactCommentPin[] = [];
	var matched: Array<{ pin: ArtifactCommentPin; element: any }> = [];
	var frame = 0;

	function owned(node: any): boolean {
		return Boolean(node && node.closest && node.closest("[" + OWNED + "]"));
	}

	function ensureStyle(): void {
		if (doc.getElementById("dev3-artifact-comment-style")) return;
		var style = doc.createElement("style");
		style.id = "dev3-artifact-comment-style";
		style.setAttribute(OWNED, "");
		style.textContent = ""
			+ "html[data-dev3-comment-mode] body{cursor:crosshair!important}"
			+ "[" + OWNED + "=hover]{position:fixed;pointer-events:none;z-index:2147483646;border:2px solid rgb(var(--dev3-accent,68 150 255));border-radius:6px;background:rgb(var(--dev3-accent,68 150 255) / .10);transition:top .06s,left .06s,width .06s,height .06s}"
			+ "[" + OWNED + "=layer]{position:absolute;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483645;pointer-events:none}"
			+ "[" + OWNED + "=pin]{position:absolute;pointer-events:auto;width:22px;height:22px;margin:-11px 0 0 -11px;border:2px solid rgb(var(--dev3-surface-base,11 14 24));border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:rgb(var(--dev3-accent,68 150 255));color:rgb(var(--dev3-on-accent,255 255 255));font:700 11px/18px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-align:center;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.35);padding:0}"
			+ "[" + OWNED + "=pin] span{display:block;transform:rotate(45deg)}"
			+ "[" + OWNED + "=pin][data-resolved]{background:rgb(var(--dev3-success,52 199 89))}"
			+ "[" + OWNED + "=pin][data-active]{outline:3px solid rgb(var(--dev3-accent,68 150 255) / .35)}"
			+ "[" + OWNED + "=target]{outline:2px dashed rgb(var(--dev3-accent,68 150 255) / .7);outline-offset:2px}";
		(doc.head || doc.documentElement).appendChild(style);
	}

	function cssPath(element: any): string {
		if (element.id && /^[A-Za-z][\w-]*$/.test(element.id)) return "#" + element.id;
		var parts: string[] = [];
		var node = element;
		while (node && node.nodeType === 1 && node !== doc.body && node !== doc.documentElement && parts.length < 8) {
			var tag = node.tagName.toLowerCase();
			if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
				parts.unshift("#" + node.id);
				break;
			}
			var parent = node.parentElement;
			var index = 1;
			if (parent) {
				var siblings = parent.children;
				var same = 0;
				for (var i = 0; i < siblings.length; i++) {
					if (siblings[i].tagName === node.tagName && !siblings[i].hasAttribute(OWNED)) {
						same++;
						if (siblings[i] === node) index = same;
					}
				}
				if (same > 1) tag += ":nth-of-type(" + index + ")";
			}
			parts.unshift(tag);
			node = parent;
		}
		return parts.join(" > ");
	}

	function cleanText(value: string): string {
		var text = String(value || "").replace(/\s+/g, " ").trim();
		return text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT - 1) + "…" : text;
	}

	function headingFor(element: any): string | null {
		var headings = doc.querySelectorAll("h1,h2,h3,h4");
		var best: any = null;
		for (var i = 0; i < headings.length; i++) {
			var h = headings[i];
			if (h === element || h.contains(element)) return null;
			// PRECEDING = the heading comes before the element in document order.
			if (element.compareDocumentPosition(h) & 2) best = h;
		}
		return best ? cleanText(best.textContent) || null : null;
	}

	function pickable(target: any): any {
		var node = target;
		while (node && node.nodeType !== 1) node = node.parentElement;
		if (!node || owned(node)) return null;
		if (node === doc.body || node === doc.documentElement) return null;
		return node;
	}

	function moveHover(element: any): void {
		if (!hoverBox) return;
		if (!element) {
			hoverBox.style.display = "none";
			return;
		}
		var rect = element.getBoundingClientRect();
		hoverBox.style.display = "block";
		hoverBox.style.left = rect.left - 2 + "px";
		hoverBox.style.top = rect.top - 2 + "px";
		hoverBox.style.width = rect.width + "px";
		hoverBox.style.height = rect.height + "px";
	}

	function onMove(event: any): void {
		if (!modeOn) return;
		moveHover(pickable(event.target));
	}

	function onClick(event: any): void {
		if (!modeOn) return;
		var element = pickable(event.target);
		if (!element) return;
		event.preventDefault();
		event.stopPropagation();
		var pick: ArtifactCommentPick = {
			selector: cssPath(element),
			text: cleanText(element.innerText !== undefined ? element.innerText : element.textContent),
			heading: headingFor(element),
		};
		channel.send({ type: "dev3-artifact-comment-pick", pick: pick });
	}

	function onKey(event: any): void {
		if (modeOn && event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			channel.send({ type: "dev3-artifact-comment-exit" });
		}
	}

	function setMode(on: boolean): void {
		modeOn = on;
		ensureStyle();
		if (on) {
			doc.documentElement.setAttribute("data-dev3-comment-mode", "");
			if (!hoverBox) {
				hoverBox = doc.createElement("div");
				hoverBox.setAttribute(OWNED, "hover");
				hoverBox.style.display = "none";
				doc.body.appendChild(hoverBox);
			}
		} else {
			doc.documentElement.removeAttribute("data-dev3-comment-mode");
			if (hoverBox) {
				hoverBox.remove();
				hoverBox = null;
			}
		}
	}

	function findByText(pin: ArtifactCommentPin): any {
		if (!pin.text) return null;
		var all = doc.body ? doc.body.querySelectorAll("*") : [];
		var candidate: any = null;
		for (var i = 0; i < all.length; i++) {
			var el = all[i];
			if (owned(el)) continue;
			var tag = el.tagName;
			if (tag === "SCRIPT" || tag === "STYLE" || tag === "HTML" || tag === "BODY") continue;
			if (cleanText(el.textContent) !== pin.text) continue;
			// Prefer the innermost element carrying exactly that text.
			candidate = el;
		}
		return candidate;
	}

	function locate(pin: ArtifactCommentPin): any {
		var element: any = null;
		try {
			element = pin.selector ? doc.querySelector(pin.selector) : null;
		} catch (e) {
			element = null;
		}
		if (element && owned(element)) element = null;
		if (element && pin.text && cleanText(element.innerText !== undefined ? element.innerText : element.textContent) !== pin.text) {
			var byText = findByText(pin);
			if (byText) element = byText;
		}
		if (!element) element = findByText(pin);
		return element;
	}

	function layout(): void {
		if (!pinLayer) return;
		var scrollX = w.pageXOffset || 0;
		var scrollY = w.pageYOffset || 0;
		for (var i = 0; i < matched.length; i++) {
			var entry = matched[i];
			var rect = entry.element.getBoundingClientRect();
			var node = pinLayer.children[i];
			if (!node) continue;
			node.style.left = rect.right + scrollX - 4 + "px";
			node.style.top = rect.top + scrollY + 4 + "px";
		}
	}

	function scheduleLayout(): void {
		if (frame) return;
		frame = w.requestAnimationFrame ? w.requestAnimationFrame(function () { frame = 0; layout(); }) : (setTimeout(function () { frame = 0; layout(); }, 16) as unknown as number);
	}

	function render(): void {
		ensureStyle();
		var previous = doc.querySelectorAll("[" + OWNED + "=target]");
		for (var p = 0; p < previous.length; p++) previous[p].removeAttribute(OWNED);
		if (!pinLayer) {
			pinLayer = doc.createElement("div");
			pinLayer.setAttribute(OWNED, "layer");
			doc.body.appendChild(pinLayer);
		}
		while (pinLayer.firstChild) pinLayer.removeChild(pinLayer.firstChild);
		matched = [];
		var unmatched: string[] = [];
		for (var i = 0; i < pins.length; i++) {
			var pin = pins[i];
			var element = locate(pin);
			if (!element) {
				unmatched.push(pin.id);
				continue;
			}
			matched.push({ pin: pin, element: element });
			var button = doc.createElement("button");
			button.type = "button";
			button.setAttribute(OWNED, "pin");
			button.setAttribute("data-pin-id", pin.id);
			button.setAttribute("aria-label", "Comment " + pin.n);
			if (pin.resolved) button.setAttribute("data-resolved", "");
			if (pin.active) {
				button.setAttribute("data-active", "");
				element.setAttribute(OWNED, "target");
			}
			var label = doc.createElement("span");
			label.textContent = String(pin.n);
			button.appendChild(label);
			button.addEventListener("click", (function (id: string) {
				return function (event: any) {
					event.preventDefault();
					event.stopPropagation();
					channel.send({ type: "dev3-artifact-comment-focus", id: id });
				};
			})(pin.id));
			pinLayer.appendChild(button);
		}
		layout();
		channel.send({ type: "dev3-artifact-comment-placed", unmatched: unmatched, matched: matched.length });
	}

	channel.subscribe(function (data: any) {
		if (!data || typeof data.type !== "string") return;
		if (data.type === "dev3-artifact-comment-mode") {
			setMode(Boolean(data.on));
		} else if (data.type === "dev3-artifact-comment-pins") {
			pins = Array.isArray(data.pins) ? data.pins : [];
			render();
		} else if (data.type === "dev3-artifact-comment-reveal") {
			for (var i = 0; i < matched.length; i++) {
				if (matched[i].pin.id === data.id && matched[i].element.scrollIntoView) {
					matched[i].element.scrollIntoView({ block: "center", inline: "nearest" });
				}
			}
		}
	});

	doc.addEventListener("mousemove", onMove, true);
	doc.addEventListener("click", onClick, true);
	w.addEventListener("keydown", onKey, true);
	w.addEventListener("scroll", scheduleLayout, true);
	w.addEventListener("resize", scheduleLayout);
	if (w.MutationObserver && doc.documentElement) {
		new w.MutationObserver(function () {
			if (pins.length) scheduleLayout();
		}).observe(doc.documentElement, { childList: true, subtree: true, attributes: true });
	}
}

export function artifactCommentScript(): string {
	const config: ArtifactCommentToolsConfig = { textLimit: ARTIFACT_COMMENT_TEXT_LIMIT };
	return `<script data-dev3-artifact-comments>(${installArtifactCommentTools.toString()})(window,${JSON.stringify(config)});</script>`;
}
