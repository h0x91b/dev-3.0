import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LabelFilterBar from "../LabelFilterBar";
import { I18nProvider } from "../../i18n";
import type { Label } from "../../../shared/types";
import type { FilterFunnelGroup } from "../../utils/taskFacets";

const LABELS: Label[] = [
	{ id: "l1", name: "Bug", color: "#ef4444" },
	{ id: "l2", name: "Feature", color: "#22c55e" },
];

const GROUPS: FilterFunnelGroup[] = [
	{ id: "priority", options: [{ facet: "priority", value: "P0", label: "P0 — Highest" }] },
	{ id: "status", options: [{ facet: "status", value: "review-by-user", label: "Your Review" }] },
	{
		id: "labels",
		options: [
			{ facet: "label", value: "Bug", label: "Bug", color: "#ef4444" },
			{ facet: "label", value: "Feature", label: "Feature", color: "#22c55e" },
		],
	},
];

function renderBar(props: Partial<React.ComponentProps<typeof LabelFilterBar>> = {}) {
	const onSearchChange = props.onSearchChange ?? vi.fn();
	render(
		<I18nProvider>
			<LabelFilterBar
				labels={props.labels ?? LABELS}
				searchQuery={props.searchQuery ?? ""}
				onSearchChange={onSearchChange}
				filterGroups={props.filterGroups ?? GROUPS}
				disableGlobalFindShortcut={props.disableGlobalFindShortcut}
			/>
		</I18nProvider>,
	);
	return { onSearchChange };
}

describe("LabelFilterBar — priority quick-filter (view of the string)", () => {
	it("renders all five priority chips", () => {
		renderBar();
		for (const level of ["P0", "P1", "P2", "P3", "P4"]) {
			expect(screen.getByRole("button", { name: new RegExp(`priority ${level}`, "i") })).toBeInTheDocument();
		}
	});

	it("clicking a priority chip inserts its token", async () => {
		const user = userEvent.setup();
		const { onSearchChange } = renderBar({ searchQuery: "" });
		await user.click(screen.getByRole("button", { name: /priority P0/i }));
		expect(onSearchChange).toHaveBeenCalledWith("priority:P0");
	});

	it("a priority chip reflects active state from the string", () => {
		renderBar({ searchQuery: "priority:P1" });
		expect(screen.getByRole("button", { name: /priority P1/i })).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByRole("button", { name: /priority P0/i })).toHaveAttribute("aria-pressed", "false");
	});
});

describe("LabelFilterBar — funnel + inline help", () => {
	it("shows the funnel plus the Priority and Labels help icons", () => {
		renderBar();
		expect(screen.getByTestId("filter-funnel-button")).toBeInTheDocument();
		// One (i) next to Priority, one next to Labels.
		expect(screen.getAllByRole("button", { name: "About this section" })).toHaveLength(2);
	});

	it("opens the Labels help card (search & filters + label management)", async () => {
		const user = userEvent.setup();
		renderBar();
		// The second (i) sits next to Labels → board.filter-bar topic.
		await user.click(screen.getAllByRole("button", { name: "About this section" })[1]);
		expect(screen.getByText(/Manage labels in Project Settings/)).toBeInTheDocument();
	});

	it("opens the Priority help card from the priority (i)", async () => {
		const user = userEvent.setup();
		renderBar();
		await user.click(screen.getAllByRole("button", { name: "About this section" })[0]);
		expect(screen.getByText(/Every task has a priority P0/)).toBeInTheDocument();
	});

	it("funnel dropdown leads with the PRIORITY group and reflects checked state", async () => {
		const user = userEvent.setup();
		renderBar({ searchQuery: "priority:P0" });
		await user.click(screen.getByTestId("filter-funnel-button"));
		expect(screen.getByRole("checkbox", { name: "P0 — Highest" })).toHaveAttribute("aria-checked", "true");
	});
});

describe("LabelFilterBar — inline label chips as a view of the string", () => {
	it("toggles the label token on chip click (add)", async () => {
		const user = userEvent.setup();
		const { onSearchChange } = renderBar({ labels: LABELS, searchQuery: "" });
		await user.click(screen.getByRole("button", { name: "Bug" }));
		expect(onSearchChange).toHaveBeenCalledWith("label:Bug");
	});

	it("toggles the label token on chip click (remove)", async () => {
		const user = userEvent.setup();
		const { onSearchChange } = renderBar({ labels: LABELS, searchQuery: "label:Bug" });
		await user.click(screen.getByRole("button", { name: "Bug" }));
		expect(onSearchChange).toHaveBeenCalledWith("");
	});

	it("shows only the top-N labels inline with a '+N more' opening the funnel", async () => {
		const user = userEvent.setup();
		// 12 labels → 10 inline + "+2 more".
		const many: Label[] = Array.from({ length: 12 }, (_, i) => ({ id: `l${i}`, name: `Label${i}`, color: "#888888" }));
		renderBar({ labels: many, filterGroups: GROUPS });
		expect(screen.getByText("Label0")).toBeInTheDocument();
		expect(screen.queryByText("Label11")).not.toBeInTheDocument();
		await user.click(screen.getByText("+2 more"));
		expect(screen.getByTestId("filter-funnel-dropdown")).toBeInTheDocument();
	});
});

describe("LabelFilterBar — search box", () => {
	it("Cmd+F focuses the search input", async () => {
		renderBar();
		const input = screen.getByPlaceholderText("Search tasks...");
		expect(input).not.toHaveFocus();
		await userEvent.keyboard("{Meta>}f{/Meta}");
		expect(input).toHaveFocus();
	});

	it("does not hijack Cmd+F when disabled", async () => {
		renderBar({ disableGlobalFindShortcut: true });
		const input = screen.getByPlaceholderText("Search tasks...");
		await userEvent.keyboard("{Meta>}f{/Meta}");
		expect(input).not.toHaveFocus();
	});

	it("the × button clears the whole string", async () => {
		const { onSearchChange } = renderBar({ searchQuery: "label:Bug login" });
		await userEvent.click(screen.getByRole("button", { name: "×" }));
		expect(onSearchChange).toHaveBeenCalledWith("");
	});

	it("Escape in the search input clears the query", async () => {
		const { onSearchChange } = renderBar({ searchQuery: "hello" });
		const input = screen.getByPlaceholderText("Search tasks...");
		await userEvent.click(input);
		await userEvent.keyboard("{Escape}");
		expect(onSearchChange).toHaveBeenCalledWith("");
	});
});

describe("LabelFilterBar — narrow viewport", () => {
	const originalInnerWidth = window.innerWidth;
	const originalMatchMedia = window.matchMedia;

	beforeEach(() => {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
		Object.defineProperty(window, "matchMedia", {
			configurable: true,
			value: (query: string) => ({
				matches: true,
				media: query,
				onchange: null,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				addListener: vi.fn(),
				removeListener: vi.fn(),
				dispatchEvent: vi.fn(),
			}),
		});
	});

	afterEach(() => {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
		Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
	});

	it("keeps the search inline and shows the funnel; inline chips are hidden", () => {
		renderBar({ labels: LABELS });
		expect(screen.getByTestId("filter-funnel-button")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Bug" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /priority P0/i })).not.toBeInTheDocument();
	});

	it("opens a bottom sheet with the grouped facets when the funnel is tapped", async () => {
		renderBar({ labels: LABELS });
		await userEvent.click(screen.getByTestId("filter-funnel-button"));
		expect(screen.getByTestId("filter-funnel-sheet")).toBeInTheDocument();
		expect(screen.getByRole("checkbox", { name: "Bug" })).toBeInTheDocument();
	});
});
