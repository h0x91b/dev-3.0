import { createRef } from "react";
import { act, render } from "@testing-library/react";
import ArtifactFrame, { type ArtifactFrameHandle } from "../ArtifactFrame";

function mount(html = "<html>one</html>") {
	const ref = createRef<ArtifactFrameHandle>();
	const messages: unknown[] = [];
	let ready = 0;
	const view = render(
		<ArtifactFrame
			ref={ref}
			title="report"
			document={html}
			className="h-full w-full"
			onMessage={(message) => messages.push(message)}
			onReady={() => { ready++; }}
		/>,
	);
	const iframe = view.container.querySelector("iframe")!;
	return { ref, messages, iframe, readyCount: () => ready, view };
}

describe("ArtifactFrame", () => {
	it("renders a sandboxed srcdoc iframe and never creates a native webview", () => {
		const { iframe, view } = mount();
		expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
		expect(iframe.getAttribute("srcdoc")).toBe("<html>one</html>");
		// The separate <electrobun-webview> host was removed; see
		// decisions/2026/09/05/artifact-viewer-back-in-the-page.md.
		expect(view.container.querySelector("electrobun-webview")).toBeNull();
	});

	it("posts a message into the frame's own window", () => {
		const { ref, iframe } = mount();
		const posted: unknown[] = [];
		Object.defineProperty(iframe, "contentWindow", {
			value: { postMessage: (message: unknown) => posted.push(message) },
			configurable: true,
		});
		act(() => { ref.current!.post({ type: "dev3-artifact-theme", theme: "dark" }); });
		expect(posted).toEqual([{ type: "dev3-artifact-theme", theme: "dark" }]);
	});

	// The app hosts other frames; a stray postMessage from any of them would
	// otherwise read as artifact traffic.
	it("takes messages from its own frame and ignores every other source", () => {
		const { messages, iframe } = mount();
		const ownWindow = { postMessage: () => {} };
		Object.defineProperty(iframe, "contentWindow", { value: ownWindow, configurable: true });

		function post(data: unknown, source: unknown) {
			const event = new MessageEvent("message", { data });
			Object.defineProperty(event, "source", { value: source, configurable: true });
			window.dispatchEvent(event);
		}

		act(() => {
			post({ type: "dev3-artifact-find-open" }, ownWindow);
			post({ type: "from-a-stranger" }, { other: true });
		});

		expect(messages).toEqual([{ type: "dev3-artifact-find-open" }]);
	});

	it("reports the document as ready when the frame loads", () => {
		const harness = mount();
		expect(harness.readyCount()).toBe(0);
		act(() => { harness.iframe.dispatchEvent(new Event("load")); });
		expect(harness.readyCount()).toBe(1);
	});
});
