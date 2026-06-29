import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Milestones } from "../Milestones";

const baseProps = {
	format: (n: number) => String(n),
	nextLabel: "Next",
	tooltipReached: (t: number) => `${t} done`,
	tooltipNext: (t: number) => `next ${t}`,
};

describe("Milestones", () => {
	it("renders an earned medal per reached tier plus the next chip's progress", () => {
		render(<Milestones reached={[10, 50]} next={100} current={75} {...baseProps} />);
		expect(screen.getByText("10")).toBeInTheDocument();
		expect(screen.getByText("50")).toBeInTheDocument();
		// The next chip shows progress toward the target as "current / next".
		expect(screen.getByText("75 / 100")).toBeInTheDocument();
	});

	it("omits the next chip once every tier is earned", () => {
		render(<Milestones reached={[10, 50]} next={null} current={60} {...baseProps} />);
		expect(screen.queryByText(/\//)).not.toBeInTheDocument();
		expect(screen.getByText("10")).toBeInTheDocument();
	});
});
