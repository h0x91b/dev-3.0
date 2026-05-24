import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TaskTmuxControls from "../task-info-panel/TaskTmuxControls";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			tmuxAction: vi.fn(),
			tmuxPaneCount: vi.fn(),
			showConfirm: vi.fn(),
		},
	},
}));

describe("TaskTmuxControls", () => {
	beforeEach(() => {
		localStorage.clear();
		vi.mocked(api.request.tmuxAction).mockReset();
		vi.mocked(api.request.tmuxPaneCount).mockReset();
		vi.mocked(api.request.showConfirm).mockReset();
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

	it("kills the pane without confirmation when more than one pane exists", async () => {
		const user = userEvent.setup();
		vi.mocked(api.request.tmuxPaneCount).mockResolvedValue({ count: 3 });
		vi.mocked(api.request.tmuxAction).mockResolvedValue(undefined);

		render(
			<I18nProvider>
				<TaskTmuxControls taskId="task-1" />
			</I18nProvider>,
		);

		await user.click(screen.getByTitle("Close pane"));

		await waitFor(() => expect(api.request.tmuxAction).toHaveBeenCalledWith({ taskId: "task-1", action: "killPane" }));
		expect(api.request.showConfirm).not.toHaveBeenCalled();
	});

	it("asks for confirmation only when the active pane is the last one, and forces the kill on accept", async () => {
		const user = userEvent.setup();
		vi.mocked(api.request.tmuxPaneCount).mockResolvedValue({ count: 1 });
		vi.mocked(api.request.showConfirm).mockResolvedValue(true);
		vi.mocked(api.request.tmuxAction).mockResolvedValue(undefined);

		render(
			<I18nProvider>
				<TaskTmuxControls taskId="task-1" />
			</I18nProvider>,
		);

		await user.click(screen.getByTitle("Close pane"));

		expect(api.request.showConfirm).toHaveBeenCalledWith({
			title: "Close the last pane?",
			message: expect.stringContaining("only remaining pane"),
		});
		await waitFor(() => expect(api.request.tmuxAction).toHaveBeenCalledWith({ taskId: "task-1", action: "killPane", force: true }));
	});

	it("does not kill the last pane when the confirmation is dismissed", async () => {
		const user = userEvent.setup();
		vi.mocked(api.request.tmuxPaneCount).mockResolvedValue({ count: 1 });
		vi.mocked(api.request.showConfirm).mockResolvedValue(false);

		render(
			<I18nProvider>
				<TaskTmuxControls taskId="task-1" />
			</I18nProvider>,
		);

		await user.click(screen.getByTitle("Close pane"));

		expect(api.request.showConfirm).toHaveBeenCalled();
		expect(api.request.tmuxAction).not.toHaveBeenCalled();
	});

	it("does not prompt for confirmation for non-destructive actions", async () => {
		const user = userEvent.setup();
		vi.mocked(api.request.tmuxAction).mockResolvedValue(undefined);

		render(
			<I18nProvider>
				<TaskTmuxControls taskId="task-1" />
			</I18nProvider>,
		);

		await user.click(screen.getByTitle("Split horizontally"));

		expect(api.request.showConfirm).not.toHaveBeenCalled();
		expect(api.request.tmuxPaneCount).not.toHaveBeenCalled();
		expect(api.request.tmuxAction).toHaveBeenCalledWith({ taskId: "task-1", action: "splitH" });
	});
});
