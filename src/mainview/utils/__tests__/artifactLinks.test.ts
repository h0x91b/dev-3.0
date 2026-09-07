import { artifactLinksScript, installArtifactLinks } from "../artifactLinks";

// A fresh document per case: the installer registers a document-level listener,
// and a shared document would keep the previous case's handler — whose
// preventDefault makes every later handler bail as already-handled.
function harness(html: string) {
	const doc = document.implementation.createHTMLDocument("artifact");
	doc.body.innerHTML = html;
	const scrolled: unknown[] = [];
	installArtifactLinks({ document: doc, scrollTo: (...args: unknown[]) => scrolled.push(args) });
	return { doc, scrolled };
}

function click(doc: Document, selector: string) {
	const event = new MouseEvent("click", { bubbles: true, cancelable: true });
	doc.querySelector(selector)!.dispatchEvent(event);
	return event;
}

function spyScroll(doc: Document, selector: string): unknown[] {
	const target = doc.querySelector(selector)! as HTMLElement & { scrollIntoView: unknown };
	const calls: unknown[] = [];
	target.scrollIntoView = (arg: unknown) => calls.push(arg);
	return calls;
}

describe("artifact in-page anchors", () => {
	it("scrolls to the target instead of opening a tab on the app's own URL", () => {
		const { doc } = harness('<a id="jump" href="#section">go</a><h2 id="section">here</h2>');
		const calls = spyScroll(doc, "#section");
		expect(click(doc, "#jump").defaultPrevented).toBe(true);
		expect(calls).toEqual([{ block: "start", behavior: "smooth" }]);
	});

	it("finds a percent-encoded target, a name= target, and survives a missing one", () => {
		const { doc } = harness('<a id="a" href="#a%20b">x</a><a id="n" href="#named">y</a><a id="m" href="#gone">z</a>'
			+ '<h2 id="a b">t</h2><a name="named"></a>');
		const encoded = spyScroll(doc, '[id="a b"]');
		const named = spyScroll(doc, '[name="named"]');
		expect(click(doc, "#a").defaultPrevented).toBe(true);
		expect(click(doc, "#n").defaultPrevented).toBe(true);
		expect(click(doc, "#m").defaultPrevented).toBe(true);
		expect(encoded).toHaveLength(1);
		expect(named).toHaveLength(1);
	});

	it("sends a bare # to the top", () => {
		const { doc, scrolled } = harness('<a id="top" href="#">top</a>');
		expect(click(doc, "#top").defaultPrevented).toBe(true);
		expect(scrolled).toEqual([[0, 0]]);
	});

	// Everything that is not an in-page anchor stays with `<base target="_blank">`.
	it("leaves an external, relative or javascript: link to the frame", () => {
		const { doc } = harness('<a id="ext" href="https://example.com/">x</a>'
			+ '<a id="rel" href="report.html">y</a><a id="js" href="javascript:alert(1)">z</a>');
		for (const id of ["#ext", "#rel", "#js"]) expect(click(doc, id).defaultPrevented).toBe(false);
	});

	it("serializes into a script tag carrying the installer", () => {
		const script = artifactLinksScript();
		expect(script).toContain("data-dev3-artifact-links");
		expect(script.endsWith("(window);</script>")).toBe(true);
	});
});
