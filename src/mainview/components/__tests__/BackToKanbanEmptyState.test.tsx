import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BackToKanbanEmptyState from "../BackToKanbanEmptyState";
import { I18nProvider } from "../../i18n";

function renderState(props: Partial<Parameters<typeof BackToKanbanEmptyState>[0]> = {}) {
	return render(
		<I18nProvider>
			<BackToKanbanEmptyState message="Nothing here" onBack={vi.fn()} {...props} />
		</I18nProvider>,
	);
}

describe("BackToKanbanEmptyState", () => {
	it("offers only the way back when no action is given", () => {
		renderState();
		expect(screen.getAllByRole("button")).toHaveLength(1);
		expect(screen.getByRole("button")).toHaveTextContent("Back to Kanban");
	});

	it("puts the action before the way back and runs it", async () => {
		const onClick = vi.fn();
		const user = userEvent.setup();
		renderState({ action: { label: "Reopen task", onClick, testId: "act" } });

		const buttons = screen.getAllByRole("button");
		expect(buttons.map((b) => b.textContent)).toEqual(["Reopen task", "Back to Kanban"]);
		await user.click(screen.getByTestId("act"));
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it("does not run a disabled action", async () => {
		const onClick = vi.fn();
		const user = userEvent.setup();
		renderState({ action: { label: "Reopen task", onClick, testId: "act", disabled: true } });

		expect(screen.getByTestId("act")).toBeDisabled();
		await user.click(screen.getByTestId("act"));
		expect(onClick).not.toHaveBeenCalled();
	});
});
