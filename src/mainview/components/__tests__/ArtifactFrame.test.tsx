import { createRef } from "react";
import { act, render } from "@testing-library/react";
import ArtifactFrame, { type ArtifactFrameHandle } from "../ArtifactFrame";
import { OVERLAY_MASK_ATTRIBUTE } from "../../utils/artifactOverlayMasks";

/**
 * A stand-in for Electrobun's `<electrobun-webview>`: same surface the component
 * drives, recording instead of talking to a native view. The real element only
 * exists inside the desktop shell, so this is the only way the webview branch —
 * the whole point of the change — gets covered at all.
 */
class FakeWebviewTag extends HTMLElement {
	listeners = new Map<string, Array<(event: CustomEvent) => void>>();
	executed: string[] = [];
	hiddenCalls: boolean[] = [];
	maskSelectors: string[] = [];
	syncCalls = 0;

	on(event: string, listener: (event: CustomEvent) => void) {
		this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
	}
	off(event: string, listener: (event: CustomEvent) => void) {
		this.listeners.set(event, (this.listeners.get(event) ?? []).filter((fn) => fn !== listener));
	}
	emit(event: string, detail?: unknown) {
		for (const listener of this.listeners.get(event) ?? []) listener(new CustomEvent(event, { detail }));
	}
	addMaskSelector(selector: string) { this.maskSelectors.push(selector); }
	toggleHidden(hidden?: boolean) { this.hiddenCalls.push(Boolean(hidden)); }
	syncDimensions() { this.syncCalls++; }
	executeJavascript(js: string) { this.executed.push(js); }
}

if (!customElements.get("electrobun-webview")) {
	customElements.define("electrobun-webview", FakeWebviewTag);
}

function sizeHost(width: number, height: number): void {
	const host = document.querySelector("[data-testid=frame-host]") as HTMLElement;
	host.getBoundingClientRect = () => ({
		left: 400, top: 100, width, height, right: 400 + width, bottom: 100 + height, x: 400, y: 100,
		toJSON: () => ({}),
	}) as DOMRect;
}

function tag(): FakeWebviewTag {
	return document.querySelector("electrobun-webview") as unknown as FakeWebviewTag;
}

/** What the host delivers is a JS statement; run it to read the message back. */
function delivered(js: string): unknown {
	let received: unknown;
	const win = { __dev3ArtifactChannel: { receive: (json: string) => { received = JSON.parse(json); } } };
	new Function("window", js)(win);
	return received;
}

interface Harness {
	ref: React.RefObject<ArtifactFrameHandle | null>;
	messages: unknown[];
	readyCount: () => number;
	rerender: (html: string) => void;
	unmount: () => void;
}

function mount(html = "<html>one</html>"): Harness {
	const ref = createRef<ArtifactFrameHandle>();
	const messages: unknown[] = [];
	let ready = 0;
	const ui = (doc: string) => (
		<ArtifactFrame
			ref={ref}
			transport="webview"
			title="report"
			document={doc}
			className="h-full w-full"
			onMessage={(message) => messages.push(message)}
			onReady={() => { ready++; }}
		/>
	);
	const view = render(ui(html));
	// The component renders a bare <div>; tag it so the tests can size it.
	(view.container.firstChild as HTMLElement).setAttribute("data-testid", "frame-host");
	return { ref, messages, readyCount: () => ready, rerender: (next) => view.rerender(ui(next)), unmount: view.unmount };
}

/**
 * What the element looked like at the instant it was inserted. Read here rather
 * than in `connectedCallback`, because happy-dom runs that callback later — late
 * enough that an element connected bare and configured afterwards still looks
 * correct from inside it, which made an earlier version of this test pass against
 * exactly the bug it was written to catch.
 */
let insertedAs: Array<{ sandbox: boolean; html: string | null }> = [];
const realAppendChild = Node.prototype.appendChild;

beforeEach(() => {
	vi.useFakeTimers();
	insertedAs = [];
	Node.prototype.appendChild = function <T extends Node>(this: Node, child: T): T {
		if (child instanceof HTMLElement && child.tagName.toLowerCase() === "electrobun-webview") {
			insertedAs.push({ sandbox: child.hasAttribute("sandbox"), html: child.getAttribute("html") });
		}
		return realAppendChild.call(this, child) as T;
	};
});

afterEach(() => {
	Node.prototype.appendChild = realAppendChild;
	vi.useRealTimers();
});

describe("ArtifactFrame — webview transport", () => {
	it("inserts the element already sandboxed and already carrying the document", () => {
		mount("<html>one</html>");
		// The real tag reads both exactly once, in its own connectedCallback, and
		// never again: inserting it bare would give an UNSANDBOXED, empty webview —
		// an artifact with Electrobun's RPC bridges to the backend.
		expect(insertedAs).toEqual([{ sandbox: true, html: "<html>one</html>" }]);
	});

	it("masks both the auto-tagged overlays and the hand-tagged in-viewer chrome", () => {
		mount();
		expect(tag().maskSelectors).toEqual([`[${OVERLAY_MASK_ATTRIBUTE}]`, "[data-dev3-artifact-overlay]"]);
	});

	it("holds messages until the document is ready, then delivers them in order", () => {
		const harness = mount();
		act(() => { harness.ref.current!.post({ type: "dev3-artifact-theme", theme: "dark" }); });
		act(() => { harness.ref.current!.post({ type: "dev3-artifact-find", query: "x" }); });
		expect(tag().executed).toEqual([]);
		expect(harness.readyCount()).toBe(0);

		act(() => { tag().emit("dom-ready"); });

		expect(tag().executed.map(delivered)).toEqual([
			{ type: "dev3-artifact-theme", theme: "dark" },
			{ type: "dev3-artifact-find", query: "x" },
		]);
		expect(harness.readyCount()).toBe(1);
	});

	it("delivers straight through once ready", () => {
		const harness = mount();
		act(() => { tag().emit("dom-ready"); });
		act(() => { harness.ref.current!.post({ type: "dev3-artifact-find-clear" }); });
		expect(tag().executed.map(delivered)).toEqual([{ type: "dev3-artifact-find-clear" }]);
	});

	// Electrobun splices the child's detail into the host page as a raw JS
	// expression, so the real event carries the already-parsed object. Measured in
	// the running app: an earlier version of this component accepted only the JSON
	// string and silently dropped every inbound message — find, save-image and
	// window.dev3 all went dead with nothing in any log.
	it("takes a host-message detail as the object it actually arrives as", () => {
		const harness = mount();
		act(() => { tag().emit("host-message", { type: "dev3-artifact-find-open" }); });
		expect(harness.messages).toEqual([{ type: "dev3-artifact-find-open" }]);
	});

	it("still takes a JSON string, and ignores a detail that is neither", () => {
		const harness = mount();
		act(() => { tag().emit("host-message", JSON.stringify({ type: "dev3-artifact-find-open" })); });
		act(() => { tag().emit("host-message", "not json at all"); });
		act(() => { tag().emit("host-message", undefined); });
		expect(harness.messages).toEqual([{ type: "dev3-artifact-find-open" }]);
	});

	it("reloads a new document in place and holds messages again until it is ready", () => {
		const harness = mount("<html>one</html>");
		act(() => { tag().emit("dom-ready"); });
		const before = tag();

		act(() => { harness.rerender("<html>two</html>"); });
		expect(tag()).toBe(before);
		expect(before.getAttribute("html")).toBe("<html>two</html>");

		act(() => { harness.ref.current!.post({ type: "dev3-artifact-theme", theme: "light" }); });
		expect(before.executed).toEqual([]);
		act(() => { before.emit("dom-ready"); });
		expect(before.executed.map(delivered)).toEqual([{ type: "dev3-artifact-theme", theme: "light" }]);
	});

	// The tag's own position sync ignores a zero rect, so a viewer laid out to
	// nothing would leave a live native layer painted over the app.
	it("takes the native layer away when the viewer is laid out to nothing, and back", () => {
		mount();
		sizeHost(0, 0);
		act(() => { vi.advanceTimersByTime(200); });
		expect(tag().hiddenCalls).toEqual([true]);

		sizeHost(600, 700);
		act(() => { vi.advanceTimersByTime(200); });
		expect(tag().hiddenCalls).toEqual([true, false]);
	});

	it("forces a position sync when an overlay opens over the artifact, and only then", () => {
		mount();
		sizeHost(600, 700);
		act(() => { vi.advanceTimersByTime(200); });
		const settled = tag().syncCalls;
		act(() => { vi.advanceTimersByTime(400); });
		expect(tag().syncCalls).toBe(settled);

		const toast = document.createElement("div");
		toast.className = "fixed";
		toast.style.position = "fixed";
		toast.getBoundingClientRect = () => ({
			left: 700, top: 120, width: 260, height: 80, right: 960, bottom: 200, x: 700, y: 120,
			toJSON: () => ({}),
		}) as DOMRect;
		document.body.appendChild(toast);

		act(() => { vi.advanceTimersByTime(200); });
		expect(tag().syncCalls).toBe(settled + 1);
		expect(toast.hasAttribute(OVERLAY_MASK_ATTRIBUTE)).toBe(true);
		toast.remove();
	});

	it("removes the native view on unmount", () => {
		const harness = mount();
		expect(tag()).toBeTruthy();
		act(() => { harness.unmount(); });
		expect(document.querySelector("electrobun-webview")).toBeNull();
	});
});

describe("ArtifactFrame — frame transport", () => {
	it("renders a sandboxed srcdoc iframe and never creates a webview", () => {
		const { container } = render(
			<ArtifactFrame
				transport="frame"
				title="report"
				document="<html>one</html>"
				onMessage={() => {}}
				onReady={() => {}}
			/>,
		);
		const iframe = container.querySelector("iframe")!;
		expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
		expect(iframe.getAttribute("srcdoc")).toBe("<html>one</html>");
		expect(container.querySelector("electrobun-webview")).toBeNull();
	});
});
