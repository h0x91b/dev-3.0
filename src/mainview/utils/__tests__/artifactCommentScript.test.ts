import { ARTIFACT_COMMENT_TEXT_LIMIT, artifactCommentScript, installArtifactCommentTools } from "../artifactCommentScript";
import { installArtifactChannel } from "../artifactChannel";

interface Sent { type: string; [key: string]: unknown }

/**
 * The tools run inside the artifact's own document. The test hands them a window
 * wrapping the REAL happy-dom document, with a distinct parent that collects what
 * the script posts, and the real channel installed on it.
 */
function install() {
	document.body.innerHTML = `
		<h1>Cockpit</h1>
		<section id="overview">
			<h2>Overview</h2>
			<div class="kpi"><span>Tasks shipped</span><b>128</b></div>
			<div class="kpi"><span>Agent success</span> <b>94.2%</b></div>
		</section>
		<section><h2>Velocity</h2><p class="note">Steady.</p></section>
	`;
	const sent: Sent[] = [];
	const listeners = new Map<string, Array<(event: unknown) => void>>();
	const win = {
		document,
		pageXOffset: 0,
		pageYOffset: 0,
		requestAnimationFrame: (fn: () => void) => { fn(); return 1; },
		addEventListener(type: string, listener: (event: never) => void) {
			const list = listeners.get(type) ?? [];
			list.push(listener as (event: unknown) => void);
			listeners.set(type, list);
		},
		fire(type: string, event: unknown) {
			for (const listener of listeners.get(type) ?? []) listener(event);
		},
		parent: { postMessage: (message: Sent) => sent.push(message) },
	};
	installArtifactChannel(win as unknown as Parameters<typeof installArtifactChannel>[0]);
	installArtifactCommentTools(win, { textLimit: ARTIFACT_COMMENT_TEXT_LIMIT });
	const host = (message: unknown) => win.fire("message", { data: message });
	return { win, sent, host };
}

afterEach(() => {
	document.body.innerHTML = "";
	document.getElementById("dev3-artifact-comment-style")?.remove();
});

describe("artifact comment tools", () => {
	it("ignores clicks until comment mode is on, then reports the picked element with selector, text and heading", () => {
		const { sent, host } = install();
		const kpi = document.querySelectorAll(".kpi")[1] as HTMLElement;
		kpi.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(sent).toEqual([]);

		host({ type: "dev3-artifact-comment-mode", on: true });
		expect(document.documentElement.hasAttribute("data-dev3-comment-mode")).toBe(true);
		const click = new MouseEvent("click", { bubbles: true, cancelable: true });
		kpi.dispatchEvent(click);
		expect(click.defaultPrevented).toBe(true);
		expect(sent).toEqual([{
			type: "dev3-artifact-comment-pick",
			pick: { selector: "#overview > div:nth-of-type(2)", text: "Agent success 94.2%", heading: "Overview" },
		}]);

		host({ type: "dev3-artifact-comment-mode", on: false });
		expect(document.documentElement.hasAttribute("data-dev3-comment-mode")).toBe(false);
	});

	it("caps the picked text", () => {
		const { sent, host } = install();
		const note = document.querySelector(".note") as HTMLElement;
		note.textContent = "x".repeat(ARTIFACT_COMMENT_TEXT_LIMIT + 50);
		host({ type: "dev3-artifact-comment-mode", on: true });
		note.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		const pick = (sent[0] as unknown as { pick: { text: string } }).pick;
		expect(pick.text).toHaveLength(ARTIFACT_COMMENT_TEXT_LIMIT);
		expect(pick.text.endsWith("…")).toBe(true);
	});

	it("draws one pin per placeable comment, falls back to the text when the selector drifted, and reports the rest", () => {
		const { sent, host } = install();
		host({
			type: "dev3-artifact-comment-pins",
			pins: [
				{ id: "a", n: 1, selector: "#overview > div:nth-of-type(2)", text: "Agent success 94.2%", heading: "Overview", resolved: false, active: true },
				{ id: "b", n: 2, selector: "#gone > p", text: "Steady.", heading: "Velocity", resolved: true, active: false },
				{ id: "c", n: 3, selector: "#gone > h9", text: "Nowhere", heading: null, resolved: false, active: false },
			],
		});
		const pins = document.querySelectorAll("[data-dev3-artifact-comment=pin]");
		expect(pins).toHaveLength(2);
		expect(pins[0].getAttribute("data-pin-id")).toBe("a");
		expect(pins[0].hasAttribute("data-active")).toBe(true);
		expect(pins[1].getAttribute("data-pin-id")).toBe("b");
		expect(pins[1].hasAttribute("data-resolved")).toBe(true);
		expect(document.querySelector(".note")?.getAttribute("data-dev3-artifact-comment")).toBeNull();
		expect((document.querySelectorAll(".kpi")[1] as HTMLElement).getAttribute("data-dev3-artifact-comment")).toBe("target");
		expect(sent).toEqual([{ type: "dev3-artifact-comment-placed", unmatched: ["c"], matched: 2 }]);

		(pins[1] as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(sent[1]).toEqual({ type: "dev3-artifact-comment-focus", id: "b" });
	});

	it("never picks its own pins", () => {
		const { sent, host } = install();
		host({ type: "dev3-artifact-comment-pins", pins: [{ id: "a", n: 1, selector: ".note", text: "Steady.", heading: null, resolved: false, active: false }] });
		host({ type: "dev3-artifact-comment-mode", on: true });
		const pin = document.querySelector("[data-dev3-artifact-comment=pin]") as HTMLElement;
		pin.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(sent.filter((m) => m.type === "dev3-artifact-comment-pick")).toEqual([]);
		expect(sent.some((m) => m.type === "dev3-artifact-comment-focus" && m.id === "a")).toBe(true);
	});

	it("serializes to a self-contained script tag", () => {
		const script = artifactCommentScript();
		expect(script.startsWith("<script data-dev3-artifact-comments>(")).toBe(true);
		expect(script).toContain('"textLimit":200');
		expect(script).not.toContain("ARTIFACT_COMMENT_OWNED_ATTR");
	});
});
