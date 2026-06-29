import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SegmentedBar } from "../SegmentedBar";

function litCount(container: HTMLElement): number {
	// Lit segments carry an accent background (full or dimmed); empty ones use bg-elevated.
	return [...container.querySelectorAll("[role='meter'] > div")].filter((el) =>
		el.className.includes("bg-accent"),
	).length;
}

describe("SegmentedBar", () => {
	it("lights segments proportionally to value/max", () => {
		const { container } = render(<SegmentedBar value={5} max={10} segments={20} />);
		expect(litCount(container)).toBe(10); // 50% of 20
	});

	it("exposes meter a11y attributes", () => {
		render(<SegmentedBar value={3} max={12} ariaLabel="proj" />);
		const meter = screen.getByRole("meter", { name: "proj" });
		expect(meter).toHaveAttribute("aria-valuenow", "3");
		expect(meter).toHaveAttribute("aria-valuemax", "12");
	});

	it("never lights more than all segments when value exceeds max", () => {
		const { container } = render(<SegmentedBar value={999} max={10} segments={16} />);
		expect(litCount(container)).toBe(16);
	});

	it("renders nothing lit at zero", () => {
		const { container } = render(<SegmentedBar value={0} max={10} segments={16} />);
		expect(litCount(container)).toBe(0);
	});
});
