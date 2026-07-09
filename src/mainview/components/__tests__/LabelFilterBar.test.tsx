import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LabelFilterBar from "../LabelFilterBar";
import { I18nProvider } from "../../i18n";

function renderBar(
	searchQuery = "",
	onSearchChange = vi.fn(),
	disableGlobalFindShortcut = false,
) {
	return render(
		<I18nProvider>
			<LabelFilterBar
				labels={[]}
				activeFilters={[]}
				onToggle={vi.fn()}
				activePriorities={[]}
				onTogglePriority={vi.fn()}
				onClear={vi.fn()}
				searchQuery={searchQuery}
				onSearchChange={onSearchChange}
				disableGlobalFindShortcut={disableGlobalFindShortcut}
			/>
		</I18nProvider>,
	);
}

describe("LabelFilterBar inline help", () => {
	it("shows both the priority and label HelpSpots when labels exist", () => {
		render(
			<I18nProvider>
				<LabelFilterBar
					labels={[{ id: "l1", name: "Bug", color: "#ef4444" }]}
					activeFilters={[]}
					onToggle={vi.fn()}
					activePriorities={[]}
					onTogglePriority={vi.fn()}
					onClear={vi.fn()}
					searchQuery=""
					onSearchChange={vi.fn()}
				/>
			</I18nProvider>,
		);
		// Two section help buttons: priority (always) + labels (labels present).
		expect(screen.getAllByRole("button", { name: "About this section" })).toHaveLength(2);
	});

	it("opens the label help card with the manage hint on click", async () => {
		const user = userEvent.setup();
		render(
			<I18nProvider>
				<LabelFilterBar
					labels={[{ id: "l1", name: "Bug", color: "#ef4444" }]}
					activeFilters={[]}
					onToggle={vi.fn()}
					activePriorities={[]}
					onTogglePriority={vi.fn()}
					onClear={vi.fn()}
					searchQuery=""
					onSearchChange={vi.fn()}
				/>
			</I18nProvider>,
		);
		// Priority HelpSpot is first in the DOM, labels HelpSpot is second.
		const spots = screen.getAllByRole("button", { name: "About this section" });
		await user.click(spots[1]);
		expect(screen.getByText(/open Project Settings → Labels/)).toBeInTheDocument();
	});

	it("always shows the priority HelpSpot, even with no labels", async () => {
		const user = userEvent.setup();
		renderBar();
		const spots = screen.getAllByRole("button", { name: "About this section" });
		expect(spots).toHaveLength(1);
		await user.click(spots[0]);
		expect(screen.getByText(/Every task has a priority/)).toBeInTheDocument();
	});
});

describe("LabelFilterBar keyboard shortcuts", () => {
	it("Cmd+F focuses the search input", async () => {
		renderBar();
		const input = screen.getByPlaceholderText("Search tasks...");
		expect(input).not.toHaveFocus();
		await userEvent.keyboard("{Meta>}f{/Meta}");
		expect(input).toHaveFocus();
	});

	it("Ctrl+F focuses the search input", async () => {
		renderBar();
		const input = screen.getByPlaceholderText("Search tasks...");
		expect(input).not.toHaveFocus();
		await userEvent.keyboard("{Control>}f{/Control}");
		expect(input).toHaveFocus();
	});

	it("does not hijack Cmd+F when disabled", async () => {
		renderBar("", vi.fn(), true);
		const input = screen.getByPlaceholderText("Search tasks...");
		expect(input).not.toHaveFocus();
		await userEvent.keyboard("{Meta>}f{/Meta}");
		expect(input).not.toHaveFocus();
	});

	it("Escape in the search input clears the query", async () => {
		const onSearchChange = vi.fn();
		renderBar("hello", onSearchChange);
		const input = screen.getByPlaceholderText("Search tasks...");
		await userEvent.click(input);
		await userEvent.keyboard("{Escape}");
		expect(onSearchChange).toHaveBeenCalledWith("");
	});

	it("Escape in the search input blurs the input", async () => {
		renderBar();
		const input = screen.getByPlaceholderText("Search tasks...");
		await userEvent.click(input);
		expect(input).toHaveFocus();
		await userEvent.keyboard("{Escape}");
		expect(input).not.toHaveFocus();
	});

	it("Escape outside the search input does not call onSearchChange", async () => {
		const onSearchChange = vi.fn();
		renderBar("", onSearchChange);
		// Focus something else, not the input
		await userEvent.keyboard("{Escape}");
		expect(onSearchChange).not.toHaveBeenCalled();
	});
});

describe("LabelFilterBar narrow viewport", () => {
	const originalInnerWidth = window.innerWidth;
	const originalMatchMedia = window.matchMedia;
	const labels = [
		{ id: "l1", name: "Bug", color: "#ef4444" },
		{ id: "l2", name: "Feature", color: "#22c55e" },
	];

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

	function renderNarrow(onToggle = vi.fn(), activeFilters: string[] = []) {
		render(
			<I18nProvider>
				<LabelFilterBar
					labels={labels}
					activeFilters={activeFilters}
					onToggle={onToggle}
					activePriorities={[]}
					onTogglePriority={vi.fn()}
					onClear={vi.fn()}
					searchQuery=""
					onSearchChange={vi.fn()}
				/>
			</I18nProvider>,
		);
		return { onToggle };
	}

	it("hides the inline label chips and shows a funnel button", () => {
		renderNarrow();
		expect(screen.getByLabelText("Filter by label")).toBeInTheDocument();
		// Chips live in the (closed) sheet, not inline.
		expect(screen.queryByText("Bug")).not.toBeInTheDocument();
	});

	it("opens a bottom sheet with the label chips when the funnel is tapped", async () => {
		renderNarrow();
		await userEvent.click(screen.getByLabelText("Filter by label"));
		expect(screen.getByTestId("label-filter-sheet")).toBeInTheDocument();
		expect(screen.getByText("Bug")).toBeInTheDocument();
		expect(screen.getByText("Feature")).toBeInTheDocument();
	});

	it("toggling a chip in the sheet calls onToggle", async () => {
		const { onToggle } = renderNarrow();
		await userEvent.click(screen.getByLabelText("Filter by label"));
		await userEvent.click(screen.getByText("Bug"));
		expect(onToggle).toHaveBeenCalledWith("l1");
	});
});

describe("LabelFilterBar priority chips", () => {
	function renderWithPriority(activePriorities: string[] = []) {
		const onTogglePriority = vi.fn();
		render(
			<I18nProvider>
				<LabelFilterBar
					labels={[]}
					activeFilters={[]}
					onToggle={vi.fn()}
					activePriorities={activePriorities as never}
					onTogglePriority={onTogglePriority}
					onClear={vi.fn()}
					searchQuery=""
					onSearchChange={vi.fn()}
				/>
			</I18nProvider>,
		);
		return { onTogglePriority };
	}

	it("renders all five priority chips even with no labels", () => {
		renderWithPriority();
		for (const level of ["P0", "P1", "P2", "P3", "P4"]) {
			expect(screen.getByRole("button", { name: new RegExp(`priority ${level}`, "i") })).toBeInTheDocument();
		}
	});

	it("toggling a priority chip calls onTogglePriority with the level", async () => {
		const { onTogglePriority } = renderWithPriority();
		await userEvent.click(screen.getByRole("button", { name: /priority P0/i }));
		expect(onTogglePriority).toHaveBeenCalledWith("P0");
	});

	it("marks an active priority chip as pressed", () => {
		renderWithPriority(["P1"]);
		expect(screen.getByRole("button", { name: /priority P1/i })).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByRole("button", { name: /priority P2/i })).toHaveAttribute("aria-pressed", "false");
	});
});
