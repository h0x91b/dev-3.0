import { collectJoinedFindRanges } from "../find-in-dom";

function cellOf(html: string): HTMLElement {
	const cell = document.createElement("div");
	cell.innerHTML = html;
	document.body.appendChild(cell);
	return cell;
}

describe("collectJoinedFindRanges", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("matches a query that spans several syntax spans", () => {
		const cell = cellOf('<span>const</span><span> </span><span>foo</span><span>(bar)</span>');

		const ranges = collectJoinedFindRanges(cell, "const foo(bar", "[data-operator]");

		expect(ranges).toHaveLength(1);
		expect(ranges[0].toString()).toBe("const foo(bar");
	});

	it("finds every occurrence, case-insensitively", () => {
		const cell = cellOf("<span>Foo f</span><span>oo foo</span>");

		const ranges = collectJoinedFindRanges(cell, "foo", "[data-operator]");

		expect(ranges.map((range) => range.toString())).toEqual(["Foo", "foo", "foo"]);
	});

	it("leaves out text under the skip selector", () => {
		const cell = cellOf('<span data-operator="+">+</span><span>+1 total</span>');

		const ranges = collectJoinedFindRanges(cell, "+", "[data-operator]");

		expect(ranges).toHaveLength(1);
		expect(ranges[0].startContainer.parentElement?.textContent).toBe("+1 total");
	});

	it("stops at the limit", () => {
		const cell = cellOf("<span>a a a a</span>");

		expect(collectJoinedFindRanges(cell, "a", "[data-operator]", 2)).toHaveLength(2);
	});
});
