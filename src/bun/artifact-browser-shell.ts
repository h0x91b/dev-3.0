import { ARTIFACT_COMMENT_TEXT_LIMIT, installArtifactCommentTools, type ArtifactCommentPick } from "../shared/artifact-comment-script";
import type { BrowserPin } from "./browser-artifact-comments";

/**
 * The browser tab's frame around an artifact, live or static: a toolbar with
 * Pick, the page in a same-origin iframe, and the feedback modal. The picker and
 * the modal live here, never in the served page, so the page stays the plain
 * artifact.
 *
 * The shell reaches into the frame (same origin) and installs the viewer's own
 * comment script there, wiring its channel to itself — so a pick here produces
 * the same selector, and the same pins, as comment mode in the app.
 */

export interface ArtifactShellConfig {
	title: string;
	/** `LIVE` for the live page, `v<N>` for a static version. */
	badge: string;
	/** Sent with every call so the server knows which page a comment is on; null is the live page. */
	artifact: { id: string; version: number } | null;
	/** Frame URL of the page itself, relative to the shell. */
	pageUrl: string;
	/** Base of the `api/*` routes, `/<token>/`. */
	base: string;
	canComment: boolean;
	textLimit: number;
}

/** What the shell's quick chips put into the box; the user can still edit the text. */
export const SHELL_QUICK_ACTIONS: Array<[label: string, text: string]> = [
	["Something's wrong", "This looks wrong: please check it."],
	["Explain this", "Explain this in plain words."],
	["Simplify", "Make this simpler to read: shorter sentences, same facts."],
	["Add an example", "Add a concrete example here."],
	["More detail", "Go deeper here: add the detail that is missing."],
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function installArtifactShell(win: any, config: ArtifactShellConfig & { quick: Array<[string, string]> }): void {
	var w = win;
	var doc = w.document;
	var frame = doc.getElementById("live-frame");
	var pickButton = doc.getElementById("live-pick");
	var countLabel = doc.getElementById("live-count");
	var toastBox = doc.getElementById("live-toast");
	var subscribers: Array<(data: unknown) => void> = [];
	var pins: BrowserPin[] = [];
	var picking = false;
	var modal: any = null;
	var marked: any = null;
	var toastTimer = 0;

	function esc(value: unknown): string {
		return String(value == null ? "" : value).replace(/[&<>"]/g, function (c) {
			return c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;";
		});
	}

	function post(message: unknown): void {
		for (var i = 0; i < subscribers.length; i++) {
			try { subscribers[i](message); } catch (error) { w.console.error(error); }
		}
	}

	function toast(text: string, bad?: boolean): void {
		toastBox.textContent = text;
		toastBox.className = bad ? "on bad" : "on";
		w.clearTimeout(toastTimer);
		toastTimer = w.setTimeout(function () { toastBox.className = ""; }, 3500);
	}

	async function api(op: string, args: unknown): Promise<any> {
		var response = await w.fetch(config.base + "api/" + op, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(Object.assign({ artifact: config.artifact }, args || {})),
		});
		var body = await response.json().catch(function () { return {}; });
		if (!response.ok) throw new Error(body.error || "HTTP " + response.status);
		return body.result;
	}

	function showPins(next: BrowserPin[]): void {
		pins = next || [];
		var open = 0;
		for (var i = 0; i < pins.length; i++) if (!pins[i].resolved) open++;
		countLabel.textContent = pins.length ? open + " open · " + pins.length + " total" : "";
		post({ type: "dev3-artifact-comment-pins", pins: pins });
	}

	async function loadPins(): Promise<void> {
		try { showPins(await api("comments", {})); } catch (error) { /* pins are a nicety; the page still works */ }
	}

	function setPicking(on: boolean): void {
		picking = on && config.canComment;
		pickButton.classList.toggle("on", picking);
		pickButton.setAttribute("aria-pressed", String(picking));
		post({ type: "dev3-artifact-comment-mode", on: picking });
		if (picking && frame.contentWindow) frame.contentWindow.focus();
	}

	function frameDoc(): any {
		try { return frame.contentDocument; } catch (error) { return null; }
	}

	function elementFor(selector: string): any {
		var d = frameDoc();
		if (!d) return null;
		try { return d.querySelector(selector); } catch (error) { return null; }
	}

	function kindOf(element: any): string {
		if (!element) return "Element";
		var tag = element.tagName;
		if (/^H[1-6]$/.test(tag)) return "Heading";
		if (tag === "TABLE") return "Table";
		if (tag === "TR") return "Table row";
		if (tag === "TD" || tag === "TH") return "Table cell";
		if (tag === "LI") return "List item";
		if (tag === "UL" || tag === "OL") return "List";
		if (tag === "IMG" || tag === "PICTURE" || tag === "FIGURE") return "Image";
		if (tag === "SVG" || tag === "svg" || tag === "CANVAS") return "Chart";
		if (tag === "BUTTON") return "Button";
		if (tag === "A") return "Link";
		if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "FORM") return "Form field";
		if (tag === "P") return "Paragraph";
		if (tag === "SECTION" || tag === "ARTICLE") return "Section";
		if (tag === "CODE" || tag === "PRE") return "Code";
		return "Element";
	}

	function mark(element: any): void {
		if (marked) marked.removeAttribute("data-dev3-live-marked");
		marked = element;
		if (!element) return;
		element.setAttribute("data-dev3-live-marked", "");
		if (element.scrollIntoView) element.scrollIntoView({ block: "nearest", inline: "nearest" });
	}

	function closeModal(): void {
		if (!modal) return;
		modal.remove();
		modal = null;
		mark(null);
	}

	function openPick(pick: ArtifactCommentPick, keepText?: string): void {
		closeModal();
		var element = elementFor(pick.selector);
		mark(element);
		var kind = kindOf(element);
		var label = pick.text ? pick.text.slice(0, 80) : pick.selector;
		var parent = element && element.parentElement;
		var canWiden = Boolean(parent && parent.tagName !== "BODY" && parent.tagName !== "HTML");
		var shade = doc.createElement("div");
		shade.className = "shade";
		shade.innerHTML = '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="pick-title">'
			+ '<h2 id="pick-title"><span class="kind">' + esc(kind) + "</span> " + esc(label) + "</h2>"
			+ '<dl class="meta">'
			+ (pick.heading ? "<dt>Section</dt><dd>" + esc(pick.heading) + "</dd>" : "")
			+ "<dt>Where</dt><dd><code>" + esc(pick.selector) + "</code></dd></dl>"
			+ (pick.text ? "<blockquote>" + esc(pick.text) + "</blockquote>" : "")
			+ '<div class="chips">' + config.quick.map(function (q, i) {
				return '<button type="button" class="chip" data-q="' + i + '">' + esc(q[0]) + "</button>";
			}).join("") + "</div>"
			+ '<textarea rows="4" placeholder="What should change here?" aria-label="What should change here?"></textarea>'
			+ '<p class="note" role="status"></p>'
			+ '<div class="row">'
			+ (canWiden ? '<button type="button" class="btn ghost grow" data-act="widen">Select parent</button>' : '<span class="grow"></span>')
			+ '<button type="button" class="btn" data-act="cancel">Cancel</button>'
			+ '<button type="button" class="btn" data-act="save">Save</button>'
			+ '<button type="button" class="btn primary" data-act="send">Send to agent <kbd>⌘↵</kbd></button>'
			+ "</div></div>";
		doc.body.appendChild(shade);
		modal = shade;
		var box = shade.querySelector("textarea");
		var note = shade.querySelector(".note");
		if (keepText) box.value = keepText;
		box.focus();

		shade.addEventListener("mousedown", function (event: any) { if (event.target === shade) closeModal(); });
		var chips = shade.querySelectorAll("[data-q]");
		for (var i = 0; i < chips.length; i++) {
			chips[i].addEventListener("click", function (event: any) {
				var chip = event.currentTarget;
				chip.classList.toggle("on");
				var quickTexts = config.quick.map(function (q) { return q[1]; });
				var own = box.value.split("\n").filter(function (line: string) { return quickTexts.indexOf(line) < 0; }).join("\n").trim();
				var picked: string[] = [];
				var on = shade.querySelectorAll("[data-q].on");
				for (var j = 0; j < on.length; j++) picked.push(config.quick[Number(on[j].getAttribute("data-q"))][1]);
				box.value = picked.concat(own ? [own] : []).join("\n");
				box.focus();
			});
		}

		async function submit(send: boolean): Promise<void> {
			var body = box.value.trim();
			if (!body) { box.focus(); return; }
			var buttons = shade.querySelectorAll("button");
			for (var k = 0; k < buttons.length; k++) buttons[k].disabled = true;
			note.textContent = send ? "Sending…" : "Saving…";
			note.className = "note";
			try {
				var result = await api("comment", { selector: pick.selector, text: pick.text, heading: pick.heading, body: body, send: send });
				closeModal();
				toast(result.sent ? "Sent to the agent" : "Saved on the task review");
				await loadPins();
			} catch (error: any) {
				for (var m = 0; m < buttons.length; m++) buttons[m].disabled = false;
				note.textContent = String(error && error.message ? error.message : error);
				note.className = "note bad";
			}
		}

		shade.addEventListener("click", function (event: any) {
			var act = event.target.closest && event.target.closest("[data-act]");
			if (!act) return;
			var name = act.getAttribute("data-act");
			if (name === "cancel") closeModal();
			else if (name === "save") void submit(false);
			else if (name === "send") void submit(true);
			else if (name === "widen") {
				pendingText = box.value;
				post({ type: "dev3-artifact-comment-widen" });
			}
		});
		box.addEventListener("keydown", function (event: any) {
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				void submit(true);
			}
		});
	}

	/** Text typed before "Select parent", carried into the wider pick's modal. */
	var pendingText = "";

	function openPin(id: string): void {
		var pin = null;
		for (var i = 0; i < pins.length; i++) if (pins[i].id === id) pin = pins[i];
		if (!pin) return;
		closeModal();
		mark(elementFor(pin.selector));
		var shade = doc.createElement("div");
		shade.className = "shade";
		shade.innerHTML = '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="pin-title">'
			+ '<h2 id="pin-title"><span class="kind">Comment ' + pin.n + "</span> " + (pin.resolved ? '<span class="done">Resolved</span>' : "") + "</h2>"
			+ "<p class=\"body\">" + esc(pin.body) + "</p>"
			+ (pin.text ? "<blockquote>" + esc(pin.text) + "</blockquote>" : "")
			+ '<div class="row"><span class="grow"></span><button type="button" class="btn" data-act="cancel">Close</button></div></div>';
		doc.body.appendChild(shade);
		modal = shade;
		shade.querySelector("[data-act=cancel]").focus();
		shade.addEventListener("mousedown", function (event: any) { if (event.target === shade) closeModal(); });
		shade.addEventListener("click", function (event: any) {
			if (event.target.closest && event.target.closest("[data-act=cancel]")) closeModal();
		});
	}

	function onFrameMessage(data: any): void {
		if (!data || typeof data.type !== "string") return;
		if (data.type === "dev3-artifact-comment-pick") {
			setPicking(false);
			var keep = pendingText;
			pendingText = "";
			openPick(data.pick, keep);
		} else if (data.type === "dev3-artifact-comment-exit") {
			setPicking(false);
		} else if (data.type === "dev3-artifact-comment-focus") {
			openPin(data.id);
		}
	}

	function wireFrame(): void {
		var fw = frame.contentWindow;
		if (!fw || !frameDoc()) return;
		subscribers = [];
		fw.__dev3ArtifactChannel = {
			send: onFrameMessage,
			subscribe: function (fn: (data: unknown) => void) { subscribers.push(fn); },
		};
		var style = fw.document.createElement("style");
		style.setAttribute("data-dev3-artifact-comment", "");
		style.textContent = "[data-dev3-live-marked]{outline:2px solid rgb(68 150 255)!important;outline-offset:3px;border-radius:2px}";
		(fw.document.head || fw.document.documentElement).appendChild(style);
		w.__dev3InstallCommentTools(fw, { textLimit: config.textLimit });
		fw.addEventListener("keydown", function (event: any) {
			if (event.key === "Escape" && modal) closeModal();
		}, true);
		if (fw.document.title) doc.title = fw.document.title + " · " + config.badge;
		post({ type: "dev3-artifact-comment-mode", on: picking });
		void loadPins();
	}

	frame.addEventListener("load", wireFrame);
	if (frameDoc() && frameDoc().readyState === "complete") wireFrame();

	pickButton.addEventListener("click", function () { setPicking(!picking); });
	doc.addEventListener("keydown", function (event: any) {
		if (event.key === "Escape") {
			if (modal) closeModal();
			else if (picking) setPicking(false);
		}
	});
}

const SHELL_CSS = `
:root{color-scheme:light dark;--font:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--bg:#f6f7f9;--bar:#ffffff;--fg:#14161b;--fg2:#5b6170;--edge:rgb(20 22 27/.12);--raised:#ffffff;--field:#f3f4f6;--accent:rgb(68 150 255);--on-accent:#fff;--danger:#d93838;--ok:#2f9e5b}
@media (prefers-color-scheme:dark){:root{--bg:#0b0e18;--bar:#11151f;--fg:#e8eaf0;--fg2:#9aa1b2;--edge:rgb(255 255 255/.10);--raised:#171c28;--field:#0f131c;--danger:#ff6b6b;--ok:#4cc38a}}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:14px/1.45 var(--font)}
body{display:flex;flex-direction:column}
.bar{flex:none;display:flex;align-items:center;gap:10px;height:44px;padding:0 12px;background:var(--bar);box-shadow:0 1px 0 var(--edge)}
.live{display:inline-flex;align-items:center;gap:6px;font:700 11px/1 var(--font);letter-spacing:.06em;color:var(--ok)}
.live::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.badge{font:700 11px/1 var(--font);letter-spacing:.04em;color:var(--fg2);padding:4px 7px;border-radius:6px;background:var(--field)}
.title{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.grow{flex:1}.row .grow{flex:none;margin-right:auto}
.count{color:var(--fg2);font-size:12.5px;white-space:nowrap;font-variant-numeric:tabular-nums}
.btn{appearance:none;border:0;border-radius:8px;padding:6px 12px;font:600 13px/1.2 var(--font);color:var(--fg);background:var(--field);box-shadow:inset 0 0 0 1px var(--edge);cursor:pointer;transition:transform .12s cubic-bezier(.2,0,0,1)}
.btn:active{transform:scale(.96)}
.btn:disabled{opacity:.55;cursor:default}
.btn.primary{background:var(--accent);color:var(--on-accent);box-shadow:none}
.btn.ghost{background:transparent;box-shadow:none;color:var(--fg2)}
.btn.on{background:var(--accent);color:var(--on-accent);box-shadow:none}
.btn kbd{font:inherit;opacity:.7;margin-left:4px}
.btn:focus-visible,.chip:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
iframe{flex:1;width:100%;border:0;background:#fff}
.shade{position:fixed;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;padding:16px;background:rgb(0 0 0/.45)}
.modal{width:540px;max-width:100%;max-height:88vh;overflow:auto;background:var(--raised);border-radius:12px;padding:18px;box-shadow:0 0 0 1px var(--edge),0 18px 48px rgb(0 0 0/.35)}
.modal h2{margin:0 0 10px;font-size:15px;line-height:1.35;overflow-wrap:anywhere;text-wrap:balance}
.kind{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--accent);margin-right:4px}
.done{font-size:12px;color:var(--ok)}
.meta{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;margin:0 0 10px;font-size:12.5px}
.meta dt{color:var(--fg2)}.meta dd{margin:0;overflow-wrap:anywhere}
code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
blockquote{margin:0 0 12px;padding:6px 10px;border-left:3px solid var(--accent);color:var(--fg2);font-size:12.5px;max-height:110px;overflow:auto;white-space:pre-wrap}
.body{margin:0 0 12px;white-space:pre-wrap}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.chip{appearance:none;border:0;border-radius:999px;padding:4px 11px;font:600 12.5px/1.3 var(--font);color:var(--fg);background:var(--field);box-shadow:inset 0 0 0 1px var(--edge);cursor:pointer}
.chip.on{background:var(--accent);color:var(--on-accent);box-shadow:none}
textarea{width:100%;min-height:96px;resize:vertical;padding:9px 10px;border:0;border-radius:8px;background:var(--field);color:var(--fg);box-shadow:inset 0 0 0 1px var(--edge);font:14px/1.45 var(--font)}
.note{min-height:1.2em;margin:6px 0 0;font-size:12.5px;color:var(--fg2)}.note.bad{color:var(--danger)}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px}
#live-toast{position:fixed;left:50%;bottom:18px;z-index:20;transform:translate(-50%,8px);opacity:0;pointer-events:none;padding:8px 14px;border-radius:999px;background:var(--fg);color:var(--bg);font-weight:600;font-size:13px;transition:opacity .16s,transform .16s cubic-bezier(.2,0,0,1)}
#live-toast.on{opacity:1;transform:translate(-50%,0)}#live-toast.bad{background:var(--danger);color:#fff}
@media (prefers-reduced-motion:reduce){.btn,#live-toast{transition:none}}
`;

function escapeHtml(value: string): string {
	return value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

/** `</script>` inside JSON would end the inline script early. */
function scriptJson(value: unknown): string {
	return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function artifactShellHtml(config: Omit<ArtifactShellConfig, "textLimit">): string {
	const full = { ...config, textLimit: ARTIFACT_COMMENT_TEXT_LIMIT, quick: SHELL_QUICK_ACTIONS };
	const badge = config.artifact ? `<span class="badge">${escapeHtml(config.badge)}</span>` : `<span class="live">LIVE</span>`;
	const pick = config.canComment
		? `<button type="button" class="btn" id="live-pick" aria-pressed="false" title="Pick an element on the page and tell the agent what should change (Esc cancels)">Pick</button>`
		: `<button type="button" class="btn" id="live-pick" hidden></button>`;
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(config.title)} · ${escapeHtml(config.badge)}</title>
<style>${SHELL_CSS}</style></head>
<body data-dev3-artifact-shell>
<header class="bar">${badge}<span class="title">${escapeHtml(config.title)}</span><span class="grow"></span><span class="count" id="live-count"></span>${pick}</header>
<iframe id="live-frame" src="${escapeHtml(config.pageUrl)}" title="${escapeHtml(config.title)}"></iframe>
<div id="live-toast" role="status" aria-live="polite"></div>
<script>window.__dev3InstallCommentTools=(${installArtifactCommentTools.toString()});(${installArtifactShell.toString()})(window,${scriptJson(full)});</script>
</body></html>`;
}
