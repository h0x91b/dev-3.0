import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverflowScroll } from "../OverflowScroll";
import Select from "../Select";

/** happy-dom has no layout: fake the two widths the component compares. */
function fakeWidths(track: number, box: number) {
	vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
		return this.classList.contains("dev3-overflow-scroll-track") ? track : 0;
	});
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
		return this.classList.contains("dev3-overflow-scroll") ? box : 0;
	});
}

afterEach(() => vi.restoreAllMocks());

describe("OverflowScroll", () => {
	it("marks a clipped label, sets its scroll distance and shows the full text as a tooltip", () => {
		fakeWidths(200, 150);
		render(<OverflowScroll fullText="Claude · Bedrock (kort)">Claude · Bedrock (kort)</OverflowScroll>);
		const box = screen.getByText("Claude · Bedrock (kort)").parentElement!;
		expect(box).toHaveAttribute("data-overflowing", "true");
		expect(box.style.getPropertyValue("--dev3-overflow-shift")).toBe("-50px");
		expect(box).toHaveAttribute("title", "Claude · Bedrock (kort)");
	});

	it("leaves a label that fits untouched", () => {
		fakeWidths(100, 150);
		render(<OverflowScroll fullText="Claude">Claude</OverflowScroll>);
		const box = screen.getByText("Claude").parentElement!;
		expect(box).not.toHaveAttribute("data-overflowing");
		expect(box).not.toHaveAttribute("title");
		expect(box.style.getPropertyValue("--dev3-overflow-shift")).toBe("");
	});

	it("wraps the Select trigger label, so a long selection can scroll", () => {
		fakeWidths(240, 120);
		render(
			<Select
				id="s"
				value="b"
				options={[{ value: "b", label: "Claude · Bedrock (shared-services)" }]}
				onChange={() => {}}
			/>,
		);
		const box = screen.getByText("Claude · Bedrock (shared-services)").parentElement!;
		expect(box).toHaveClass("dev3-overflow-scroll");
		expect(box).toHaveAttribute("data-overflowing", "true");
	});
});
