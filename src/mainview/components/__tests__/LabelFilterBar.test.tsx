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
				onClear={vi.fn()}
				searchQuery={searchQuery}
				onSearchChange={onSearchChange}
				disableGlobalFindShortcut={disableGlobalFindShortcut}
			/>
		</I18nProvider>,
	);
}

describe("LabelFilterBar manage hint", () => {
	it("shows a manage hint pointing to Project Settings when labels exist", () => {
		render(
			<I18nProvider>
				<LabelFilterBar
					labels={[{ id: "l1", name: "Bug", color: "#ef4444" }]}
					activeFilters={[]}
					onToggle={vi.fn()}
					onClear={vi.fn()}
					searchQuery=""
					onSearchChange={vi.fn()}
				/>
			</I18nProvider>,
		);
		expect(
			screen.getByTitle("To rename, recolor or delete labels, open Project Settings → Labels."),
		).toBeInTheDocument();
	});

	it("does not show the manage hint when there are no labels", () => {
		renderBar();
		expect(
			screen.queryByTitle("To rename, recolor or delete labels, open Project Settings → Labels."),
		).not.toBeInTheDocument();
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
