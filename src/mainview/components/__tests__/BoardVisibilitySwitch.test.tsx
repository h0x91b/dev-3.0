import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import BoardVisibilitySwitch from "../BoardVisibilitySwitch";
import { I18nProvider } from "../../i18n";
import type { TaskVisibility } from "../../../shared/board-filter-state";

function Harness({ initial, onChange, narrow, confirmed }: { initial: TaskVisibility; onChange: (v: TaskVisibility) => void; narrow?: boolean; confirmed?: boolean }) {
	const [visibility, setVisibility] = useState(initial);
	return (
		<I18nProvider>
			<BoardVisibilitySwitch visibility={visibility} onChange={(v) => { setVisibility(v); onChange(v); }} narrow={narrow} confirmed={confirmed} />
		</I18nProvider>
	);
}

function renderSwitch(initial: TaskVisibility) {
	const onChange = vi.fn();
	render(<Harness initial={initial} onChange={onChange} />);
	return { onChange };
}

const radio = (name: string) => screen.getByRole("radio", { name });

describe("BoardVisibilitySwitch", () => {
	it("keeps the compact segment size on a wide board", () => {
		renderSwitch("all");
		expect(radio("Active")).toHaveClass("px-2", "py-0.5", "text-xs", "leading-4");
	});

	it("uses touch-size segments, as tall as the narrow search input, on a narrow board", () => {
		render(<Harness initial="all" onChange={vi.fn()} narrow />);
		for (const name of ["Active", "All"]) {
			expect(radio(name)).toHaveClass("px-2.5", "py-1", "text-sm", "leading-5");
			expect(radio(name)).not.toHaveClass("text-xs");
		}
	});

	it("renders Active then All and marks the selected one", () => {
		renderSwitch("all");
		const radios = screen.getAllByRole("radio");
		expect(radios.map((r) => r.textContent)).toEqual(["Active", "All"]);
		expect(radios[0]).toHaveAttribute("aria-checked", "false");
		expect(radios[1]).toHaveAttribute("aria-checked", "true");
		expect(radios[0]).toHaveAttribute("tabindex", "-1");
		expect(radios[1]).toHaveAttribute("tabindex", "0");
		expect(screen.getByRole("radiogroup", { name: "Show tasks" })).toBeInTheDocument();
		expect(radios[0]).toHaveAttribute("title", "Hide completed and cancelled tasks");
		expect(radios[0]).toHaveAttribute("aria-description", "Hide completed and cancelled tasks");
		expect(radios[1]).not.toHaveAttribute("aria-description");
	});

	it("selects on click and ignores a click on the selected segment", async () => {
		const { onChange } = renderSwitch("all");
		await userEvent.click(radio("All"));
		expect(onChange).not.toHaveBeenCalled();
		await userEvent.click(radio("Active"));
		expect(onChange).toHaveBeenCalledWith("active");
	});

	it("counts a click on the shown value as a pick while the value is only a placeholder", async () => {
		const onChange = vi.fn();
		render(<Harness initial="all" onChange={onChange} confirmed={false} />);
		await userEvent.click(radio("All"));
		expect(onChange).toHaveBeenCalledWith("all");
	});

	it.each([
		["ArrowLeft", "active"],
		["ArrowUp", "active"],
		["Home", "active"],
	])("%s from All selects Active, focuses it and moves the tab stop", async (key, expected) => {
		const { onChange } = renderSwitch("all");
		radio("All").focus();
		await userEvent.keyboard(`{${key}}`);
		expect(onChange).toHaveBeenLastCalledWith(expected);
		expect(radio("Active")).toHaveFocus();
		expect(radio("Active")).toHaveAttribute("aria-checked", "true");
		expect(radio("Active")).toHaveAttribute("tabindex", "0");
		expect(radio("All")).toHaveAttribute("tabindex", "-1");
	});

	it.each(["ArrowRight", "ArrowDown", "End"])("%s from Active selects All and moves the tab stop", async (key) => {
		const { onChange } = renderSwitch("active");
		radio("Active").focus();
		await userEvent.keyboard(`{${key}}`);
		expect(onChange).toHaveBeenLastCalledWith("all");
		expect(radio("All")).toHaveFocus();
		expect(radio("All")).toHaveAttribute("tabindex", "0");
		expect(radio("Active")).toHaveAttribute("tabindex", "-1");
	});
});
