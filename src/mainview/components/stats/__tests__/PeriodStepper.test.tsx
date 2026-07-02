import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PeriodStepper } from "../PeriodStepper";

function setup(over: Partial<Parameters<typeof PeriodStepper>[0]> = {}) {
	const onOlder = vi.fn();
	const onNewer = vi.fn();
	const onReset = vi.fn();
	render(
		<PeriodStepper
			label="This week"
			labelTitle="Jun 25 – Jul 1"
			groupLabel="Time period"
			atCurrent={true}
			canOlder={true}
			canNewer={false}
			onOlder={onOlder}
			onNewer={onNewer}
			onReset={onReset}
			prevLabel="Previous period"
			nextLabel="Next period"
			{...over}
		/>,
	);
	return { onOlder, onNewer, onReset };
}

describe("PeriodStepper", () => {
	it("renders the label inside a labelled group", () => {
		setup();
		expect(screen.getByRole("group", { name: "Time period" })).toBeInTheDocument();
		expect(screen.getByText("This week")).toBeInTheDocument();
	});

	it("steps older when the ‹ arrow is clicked", async () => {
		const { onOlder } = setup();
		await userEvent.click(screen.getByRole("button", { name: "Previous period" }));
		expect(onOlder).toHaveBeenCalledTimes(1);
	});

	it("disables the ‹ arrow when there is no older data", async () => {
		const { onOlder } = setup({ canOlder: false });
		const prev = screen.getByRole("button", { name: "Previous period" });
		expect(prev).toBeDisabled();
		await userEvent.click(prev);
		expect(onOlder).not.toHaveBeenCalled();
	});

	it("disables the › arrow at the current period", async () => {
		const { onNewer } = setup({ canNewer: false });
		const next = screen.getByRole("button", { name: "Next period" });
		expect(next).toBeDisabled();
		await userEvent.click(next);
		expect(onNewer).not.toHaveBeenCalled();
	});

	it("resets to the current period when the label is clicked (and is inert at current)", async () => {
		// Inert at the current period.
		const current = setup({ atCurrent: true });
		await userEvent.click(screen.getByText("This week"));
		expect(current.onReset).not.toHaveBeenCalled();
		screen.getByText("This week").remove();

		// Clickable once navigated into the past.
		const past = setup({ atCurrent: false, canNewer: true, label: "Last week" });
		await userEvent.click(screen.getByText("Last week"));
		expect(past.onReset).toHaveBeenCalledTimes(1);
	});
});
