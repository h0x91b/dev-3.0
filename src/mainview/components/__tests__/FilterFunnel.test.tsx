import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import FilterFunnel from "../FilterFunnel";
import { I18nProvider } from "../../i18n";
import type { FilterFunnelGroup } from "../../utils/taskFacets";

const GROUPS: FilterFunnelGroup[] = [
	{
		id: "agents",
		options: [
			{ facet: "agent", value: "Claude", label: "Claude" },
			{ facet: "agent", value: "Codex", label: "Codex" },
		],
	},
	{
		id: "flags",
		options: [{ facet: "is", value: "attention", label: "Needs attention" }],
	},
];

function renderFunnel(query = "", onChange = vi.fn(), groups = GROUPS) {
	render(
		<I18nProvider>
			<div>
				<button type="button">outside</button>
				<FilterFunnel query={query} onChange={onChange} groups={groups} />
			</div>
		</I18nProvider>,
	);
	return { onChange };
}

describe("FilterFunnel", () => {
	it("renders nothing when there are no groups", () => {
		renderFunnel("", vi.fn(), []);
		expect(screen.queryByTestId("filter-funnel-button")).not.toBeInTheDocument();
	});

	it("toggles the dropdown open and closed on button click", async () => {
		const user = userEvent.setup();
		renderFunnel();
		const btn = screen.getByTestId("filter-funnel-button");
		expect(screen.queryByTestId("filter-funnel-dropdown")).not.toBeInTheDocument();
		await user.click(btn);
		expect(screen.getByTestId("filter-funnel-dropdown")).toBeInTheDocument();
		await user.click(btn);
		expect(screen.queryByTestId("filter-funnel-dropdown")).not.toBeInTheDocument();
	});

	it("closes on Escape", async () => {
		const user = userEvent.setup();
		renderFunnel();
		await user.click(screen.getByTestId("filter-funnel-button"));
		await user.keyboard("{Escape}");
		expect(screen.queryByTestId("filter-funnel-dropdown")).not.toBeInTheDocument();
	});

	it("closes on an outside click", async () => {
		const user = userEvent.setup();
		renderFunnel();
		await user.click(screen.getByTestId("filter-funnel-button"));
		await user.click(screen.getByRole("button", { name: "outside" }));
		expect(screen.queryByTestId("filter-funnel-dropdown")).not.toBeInTheDocument();
	});

	it("emits the toggled query string when a value is checked", async () => {
		const user = userEvent.setup();
		const { onChange } = renderFunnel("");
		await user.click(screen.getByTestId("filter-funnel-button"));
		await user.click(screen.getByRole("checkbox", { name: "Codex" }));
		expect(onChange).toHaveBeenCalledWith("agent:Codex");
	});

	it("reflects checked state and count badge from the query", async () => {
		const user = userEvent.setup();
		renderFunnel("agent:Codex is:attention");
		expect(screen.getByTestId("filter-funnel-badge")).toHaveTextContent("2");
		await user.click(screen.getByTestId("filter-funnel-button"));
		expect(screen.getByRole("checkbox", { name: "Codex" })).toHaveAttribute("aria-checked", "true");
		expect(screen.getByRole("checkbox", { name: "Claude" })).toHaveAttribute("aria-checked", "false");
		expect(screen.getByRole("checkbox", { name: "Needs attention" })).toHaveAttribute("aria-checked", "true");
	});
});
