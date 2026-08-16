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

	it("keeps the trigger as the only combobox when there is no filter field", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		await user.click(trigger());
		expect(screen.getAllByRole("combobox")).toHaveLength(1);
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

const modes: SelectOption[] = [
	{ value: "auto", label: "Auto" },
	{ value: "bypassPermissions", label: "Bypass" },
	{ value: "xhigh", label: "X-High" },
];

function CreatableHarness({
	onChange,
	initial = "auto",
	allowCustom = true,
}: {
	onChange?: (v: string) => void;
	initial?: string;
	allowCustom?: boolean;
}) {
	const [value, setValue] = useState(initial);
	return (
		<Select
			value={value}
			options={modes}
			searchable
			allowCustom={allowCustom}
			searchPlaceholder="Filter or type your own"
			customOptionLabel={(q) => `Use “${q}”`}
			emptyLabel="Nothing matches"
			onChange={(v) => {
				setValue(v);
				onChange?.(v);
			}}
		/>
	);
}

const openBtn = () => screen.getByRole("button");
const filterField = () => screen.getByRole("combobox", { name: "Filter or type your own" });

describe("Select — searchable + creatable", () => {
	it("moves the combobox role onto the filter field and focuses it on open", async () => {
		const user = userEvent.setup();
		render(<CreatableHarness />);
		expect(openBtn()).toHaveAttribute("aria-haspopup", "listbox");
		expect(openBtn()).not.toHaveAttribute("role", "combobox");

		await user.click(openBtn());
		expect(filterField()).toHaveFocus();
		expect(screen.getByRole("listbox")).not.toBeNull();
	});

	it("filters options loosely, so “xhigh” finds “X-High”", async () => {
		const user = userEvent.setup();
		render(<CreatableHarness />);
		await user.click(openBtn());
		await user.type(filterField(), "xhigh");
		expect(screen.getByRole("option", { name: "X-High" })).not.toBeNull();
		expect(screen.queryByRole("option", { name: "Auto" })).toBeNull();
	});

	it("commits typed text that matches nothing as the value", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(<CreatableHarness onChange={onChange} />);
		await user.click(openBtn());
		await user.type(filterField(), "yolo-mode");
		await user.click(screen.getByRole("option", { name: "Use “yolo-mode”" }));
		expect(onChange).toHaveBeenCalledWith("yolo-mode");
		expect(openBtn()).toHaveTextContent("yolo-mode");
	});

	it("Enter commits the active row, so typing then Enter is enough", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(<CreatableHarness onChange={onChange} />);
		await user.click(openBtn());
		await user.type(filterField(), "bypass{Enter}");
		expect(onChange).toHaveBeenCalledWith("bypassPermissions");
	});

	it("shows an off-list current value as a selected row", async () => {
		const user = userEvent.setup();
		render(<CreatableHarness initial="claude-opus-6" />);
		expect(openBtn()).toHaveTextContent("claude-opus-6");
		await user.click(openBtn());
		expect(screen.getByRole("option", { name: "claude-opus-6" })).toHaveAttribute("aria-selected", "true");
	});

	it("says so when nothing matches and custom values are off", async () => {
		const user = userEvent.setup();
		render(<CreatableHarness allowCustom={false} />);
		await user.click(openBtn());
		await user.type(filterField(), "zzz");
		expect(screen.getByText("Nothing matches")).not.toBeNull();
		expect(screen.queryAllByRole("option")).toHaveLength(0);
	});
});

describe("section headings", () => {
	const sectioned: SelectOption[] = [
		{ value: "a", label: "Alpha", section: "Yours" },
		{ value: "b", label: "Beta", section: "Yours" },
		{ value: "c", label: "Gamma", section: "Locked", disabled: true },
	];

	function SectionHarness() {
		const [value, setValue] = useState("a");
		return <Select id="sectioned" value={value} options={sectioned} onChange={setValue} />;
	}

	it("renders each heading once, above its first option", async () => {
		const user = userEvent.setup();
		render(<SectionHarness />);
		await user.click(trigger());
		expect(screen.getAllByText("Yours")).toHaveLength(1);
		expect(screen.getAllByText("Locked")).toHaveLength(1);
	});

	it("keeps headings out of the listbox's options, so arrow keys still count right", async () => {
		const user = userEvent.setup();
		render(<SectionHarness />);
		await user.click(trigger());
		// Three options, not five: a heading that became a row would break both
		// keyboard navigation and what a screen reader announces.
		expect(screen.getAllByRole("option")).toHaveLength(3);
	});

	it("moves the active option straight from the last of one section to the first of the next", async () => {
		const user = userEvent.setup();
		render(<SectionHarness />);
		await user.click(trigger());
		await user.keyboard("{ArrowDown}{ArrowDown}");
		expect(activeOptionLabel()).toMatch(/Gamma/);
	});
});

describe("growList", () => {
	function widthOf(): { width: string; minWidth: string } {
		const panel = document.querySelector("[role=listbox]") as HTMLElement;
		return { width: panel.style.width, minWidth: panel.style.minWidth };
	}

	it("keeps the panel pinned to the trigger's width by default", async () => {
		const user = userEvent.setup();
		render(<Select value="a" options={[{ value: "a", label: "Alpha" }]} onChange={() => {}} />);
		await user.click(screen.getByRole("combobox"));
		// The measured trigger width, not a keyword. (jsdom measures 0.)
		expect(widthOf().width).not.toBe("max-content");
		expect(widthOf().minWidth).toBe("");
	});

	it("lets the panel grow past the trigger when asked, with the trigger as the floor", async () => {
		const user = userEvent.setup();
		render(<Select value="a" options={[{ value: "a", label: "Alpha" }]} onChange={() => {}} growList />);
		await user.click(screen.getByRole("combobox"));
		const { width, minWidth } = widthOf();
		expect(width).toBe("max-content");
		// The floor is set from the trigger, so a short list still fills the field.
		expect(minWidth).not.toBe("");
	});
});
