import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import Select, { type SelectOption } from "../Select";
import { useEscapeKey } from "../../hooks/useEscapeKey";

const options: SelectOption[] = [
	{ value: "alpha", label: "Alpha" },
	{ value: "beta", label: "Beta" },
	{ value: "gamma", label: "Gamma", disabled: true },
	{ value: "delta", label: "Delta" },
];

/** Stands in for the launch modal that owns Escape around the dropdown. */
function Harness({
	onChange,
	onOuterEscape,
	onGated,
}: {
	onChange?: (v: string) => void;
	onOuterEscape?: () => void;
	onGated?: (v: string) => void;
}) {
	const [value, setValue] = useState("alpha");
	useEscapeKey(() => onOuterEscape?.(), { enabled: !!onOuterEscape });
	return (
		<Select
			id="test-select"
			value={value}
			options={options}
			onChange={(v) => {
				setValue(v);
				onChange?.(v);
			}}
			onOptionDisabledClick={onGated}
		/>
	);
}

const trigger = () => screen.getByRole("combobox");
const activeOptionLabel = () => {
	const id = trigger().getAttribute("aria-activedescendant");
	return id ? document.getElementById(id)?.textContent?.trim() : undefined;
};

describe("Select — combobox keyboard model", () => {
	it("exposes combobox semantics and toggles aria-expanded", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		expect(trigger()).toHaveAttribute("aria-haspopup", "listbox");
		expect(trigger()).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByRole("listbox")).toBeNull();

		await user.click(trigger());
		expect(trigger()).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByRole("listbox")).not.toBeNull();
		// The current value reads as selected; the gated row stays reachable.
		expect(screen.getByRole("option", { name: "Alpha" })).toHaveAttribute("aria-selected", "true");
		expect(screen.getByRole("option", { name: /Gamma/ })).toHaveAttribute("aria-disabled", "true");
		expect(screen.getByRole("option", { name: /Gamma/ })).not.toBeDisabled();
	});

	it("ArrowDown opens the list, moves the active option, and Enter commits it", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(<Harness onChange={onChange} />);

		trigger().focus();
		await user.keyboard("{ArrowDown}");
		expect(trigger()).toHaveAttribute("aria-expanded", "true");
		// Opens on the current value, not on the first row.
		expect(activeOptionLabel()).toBe("Alpha");

		await user.keyboard("{ArrowDown}");
		expect(activeOptionLabel()).toBe("Beta");

		await user.keyboard("{Enter}");
		expect(onChange).toHaveBeenCalledWith("beta");
		expect(screen.queryByRole("listbox")).toBeNull();
	});

	it("Home/End jump and typeahead jumps to the first matching label", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		trigger().focus();
		await user.keyboard("{ArrowDown}{End}");
		expect(activeOptionLabel()).toBe("Delta");
		await user.keyboard("{Home}");
		expect(activeOptionLabel()).toBe("Alpha");
		await user.keyboard("b");
		expect(activeOptionLabel()).toBe("Beta");
	});

	it("Enter on a gated option explains itself instead of committing", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		const onGated = vi.fn();
		render(<Harness onChange={onChange} onGated={onGated} />);
		trigger().focus();
		await user.keyboard("{ArrowDown}g{Enter}");
		expect(onGated).toHaveBeenCalledWith("gamma");
		expect(onChange).not.toHaveBeenCalled();
	});

	it("Escape closes the dropdown without closing the surrounding modal", async () => {
		const user = userEvent.setup();
		const onOuterEscape = vi.fn();
		render(<Harness onOuterEscape={onOuterEscape} />);

		await user.click(trigger());
		expect(screen.getByRole("listbox")).not.toBeNull();

		await user.keyboard("{Escape}");
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(onOuterEscape).not.toHaveBeenCalled();

		// Second Escape falls through to the modal.
		await user.keyboard("{Escape}");
		expect(onOuterEscape).toHaveBeenCalledTimes(1);
	});
});
