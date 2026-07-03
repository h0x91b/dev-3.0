import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TaskTmuxControls from "../task-info-panel/TaskTmuxControls";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";
import { confirm } from "../../confirm";
import { CLOSE_PANE_PICKER_EVENT } from "../../close-pane-picker";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			tmuxAction: vi.fn(),
			tmuxPaneCount: vi.fn(),
		},
	},
}));

vi.mock("../../confirm", () => ({
	confirm: vi.fn(),
	ConfirmHost: () => null,
}));

// Controllable viewport: the Close Pane button opens the picker on a desktop
// split but keeps the direct-kill fallback on a narrow (one-pane) viewport.
let mockNarrow = false;
vi.mock("../../hooks/useNarrowViewport", () => ({
	useNarrowViewport: () => mockNarrow,
}));

describe("TaskTmuxControls", () => {
	beforeEach(() => {
		localStorage.clear();
		mockNarrow = false;
		vi.mocked(api.request.tmuxAction).mockReset();
		vi.mocked(api.request.tmuxPaneCount).mockReset();
		vi.mocked(confirm).mockReset();
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

	it("opens the two-step pane picker instead of killing directly (desktop split)", async () => {
		const user = userEvent.setup();
		const onPicker = vi.fn();
		window.addEventListener(CLOSE_PANE_PICKER_EVENT, onPicker);

		render(
			<I18nProvider>
				<TaskTmuxControls taskId="task-1" />
			</I18nProvider>,
		);

		await user.click(screen.getByTitle("Close pane"));

		expect(onPicker).toHaveBeenCalledTimes(1);
		expect((onPicker.mock.calls[0][0] as CustomEvent).detail).toEqual({ taskId: "task-1" });
		// The picker owns the kill now — the button never touches tmux directly here.
		expect(api.request.tmuxAction).not.toHaveBeenCalled();
		expect(api.request.tmuxPaneCount).not.toHaveBeenCalled();
		expect(confirm).not.toHaveBeenCalled();

		window.removeEventListener(CLOSE_PANE_PICKER_EVENT, onPicker);
	});

	describe("narrow viewport (direct kill fallback)", () => {
		beforeEach(() => {
			mockNarrow = true;
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
			expect(confirm).not.toHaveBeenCalled();
		});

		it("asks for confirmation only when the active pane is the last one, and forces the kill on accept", async () => {
			const user = userEvent.setup();
			vi.mocked(api.request.tmuxPaneCount).mockResolvedValue({ count: 1 });
			vi.mocked(confirm).mockResolvedValue(true);
			vi.mocked(api.request.tmuxAction).mockResolvedValue(undefined);

			render(
				<I18nProvider>
					<TaskTmuxControls taskId="task-1" />
				</I18nProvider>,
			);

			await user.click(screen.getByTitle("Close pane"));

			expect(confirm).toHaveBeenCalledWith({
				title: "Close the last pane?",
				message: expect.stringContaining("only remaining pane"),
				danger: true,
			});
			await waitFor(() => expect(api.request.tmuxAction).toHaveBeenCalledWith({ taskId: "task-1", action: "killPane", force: true }));
		});

		it("does not kill the last pane when the confirmation is dismissed", async () => {
			const user = userEvent.setup();
			vi.mocked(api.request.tmuxPaneCount).mockResolvedValue({ count: 1 });
			vi.mocked(confirm).mockResolvedValue(false);

			render(
				<I18nProvider>
					<TaskTmuxControls taskId="task-1" />
				</I18nProvider>,
			);

			await user.click(screen.getByTitle("Close pane"));

			expect(confirm).toHaveBeenCalled();
			expect(api.request.tmuxAction).not.toHaveBeenCalled();
		});
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

		expect(confirm).not.toHaveBeenCalled();
		expect(api.request.tmuxPaneCount).not.toHaveBeenCalled();
		expect(api.request.tmuxAction).toHaveBeenCalledWith({ taskId: "task-1", action: "splitH" });
	});

	it("opens a new tmux window from the green new-window button", async () => {
		const user = userEvent.setup();
		vi.mocked(api.request.tmuxAction).mockResolvedValue(undefined);

		render(
			<I18nProvider>
				<TaskTmuxControls taskId="task-1" />
			</I18nProvider>,
		);

		await user.click(screen.getByTitle("New window"));

		expect(confirm).not.toHaveBeenCalled();
		expect(api.request.tmuxAction).toHaveBeenCalledWith({ taskId: "task-1", action: "newWindow" });
	});

	it("cycles tmux layouts from the split-button primary action", async () => {
		const user = userEvent.setup();
		vi.mocked(api.request.tmuxAction).mockResolvedValue(undefined);

		render(
			<I18nProvider>
				<TaskTmuxControls taskId="task-1" />
			</I18nProvider>,
		);

		await user.click(screen.getByTitle("Cycle layouts"));

		expect(api.request.tmuxAction).toHaveBeenCalledWith({ taskId: "task-1", action: "nextLayout" });
	});

	it("opens the tmux layout menu and applies the chosen preset", async () => {
		const user = userEvent.setup();
		vi.mocked(api.request.tmuxAction).mockResolvedValue(undefined);

		render(
			<I18nProvider>
				<TaskTmuxControls taskId="task-1" />
			</I18nProvider>,
		);

		// Layout presets are hidden behind the dropdown caret, not shown inline.
		expect(screen.queryByText("Tiled (grid)")).not.toBeInTheDocument();

		await user.click(screen.getByTitle("Choose tmux layout"));

		const tiled = await screen.findByText("Tiled (grid)");
		await user.click(tiled);

		expect(api.request.tmuxAction).toHaveBeenCalledWith({ taskId: "task-1", action: "layoutTiled" });
	});
});
