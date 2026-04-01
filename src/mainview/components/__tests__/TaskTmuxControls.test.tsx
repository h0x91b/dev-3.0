import { render, screen } from "@testing-library/react";
import TaskTmuxControls from "../task-info-panel/TaskTmuxControls";
import { I18nProvider } from "../../i18n";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			tmuxAction: vi.fn(),
		},
	},
}));

describe("TaskTmuxControls", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("keeps info and close controls aligned with the shared tmux button spacing", () => {
		render(
			<I18nProvider>
				<TaskTmuxControls taskId="task-1" />
			</I18nProvider>,
		);

		const infoButton = screen.getByTitle("tmux Shortcuts");
		const closeButton = screen.getByTitle("Close pane");

		expect(infoButton).toHaveClass("px-1.5", "py-1", "rounded", "border", "border-edge");
		expect(closeButton).not.toHaveClass("ml-2");
	});
});
