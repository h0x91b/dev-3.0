import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

	it("marks the keyboard-active listbox row, which the scroll rules match", async () => {
		fakeWidths(240, 120);
		render(<Select id="s" value="a" options={[{ value: "a", label: "Claude · Bedrock (shared-services)" }]} onChange={() => {}} />);
		await userEvent.setup().click(screen.getByRole("combobox"));
		const option = screen.getByRole("option");
		expect(option).toHaveAttribute("data-active", "true");
		expect(option.querySelector(".dev3-overflow-scroll")).toHaveAttribute("data-overflowing", "true");
	});
});

/** happy-dom runs no CSS animations, so the scroll rules are checked in the stylesheet itself. */
describe("overflow scroll stylesheet", () => {
	const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8");
	const trackRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
		.map(([, selector, body]) => ({ selector: selector.trim(), body }))
		.filter((r) => r.selector.endsWith(".dev3-overflow-scroll-track") && /animation:\s*dev3-overflow-scroll/.test(r.body));

	it("never loops the scroll while a trigger merely keeps keyboard focus", () => {
		const looping = trackRules.filter((r) => /\binfinite\b/.test(r.body));
		expect(looping.length).toBeGreaterThan(0);
		for (const rule of looping) expect(rule.selector).not.toContain("focus-visible");
		const focus = trackRules.filter((r) => r.selector.includes("focus-visible"));
		expect(focus).toHaveLength(1);
		expect(focus[0].body).not.toMatch(/\binfinite\b/);
		const unmaskedForGood = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
			.filter(([, selector, body]) => selector.includes("focus-visible") && /(^|[^-])mask-image:\s*none/.test(body));
		expect(unmaskedForGood).toEqual([]);
	});

	it("scopes the active-row arm to listbox options", () => {
		const scrollSelectors = [...css.matchAll(/([^{}]*\.dev3-overflow-scroll[^{}]*)\{/g)].map((m) => m[1]);
		for (const selector of scrollSelectors) expect(selector).not.toMatch(/[\s(,]\[data-active\]/);
	});
});
