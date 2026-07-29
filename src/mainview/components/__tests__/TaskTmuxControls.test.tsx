import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TaskTmuxControls from "../task-info-panel/TaskTmuxControls";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";
import { confirm } from "../../confirm";
import { CLOSE_PANE_PICKER_EVENT } from "../../close-pane-picker";

const makeState = (count: number) => ({
	backend: "tmux" as const,
	panes: Array.from({ length: count }, (_, i) => ({
		paneId: `%${i + 1}`,
		index: i,
		label: "",
		active: i === 0,
		zoomed: false,
		rect: { x: 0, y: 0, width: 1, height: 1 },
	})),
	activePaneId: count > 0 ? "%1" : null,
	zoomedPaneId: null,
	layout: null,
	layoutPreset: null,
	capabilities: ["split" as const],
});

vi.mock("../../rpc", () => ({
	api: {
		request: {
			taskPaneAction: vi.fn(),
			taskPaneState: vi.fn(),
			tmuxNewWindow: vi.fn(),
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
		vi.mocked(api.request.taskPaneAction).mockReset();
		vi.mocked(api.request.taskPaneState).mockReset();
		vi.mocked(api.request.tmuxNewWindow).mockReset();
		vi.mocked(confirm).mockReset();
	});

	it("keeps info and close controls aligned with the shared tmux button spacing", () => {
		render(
			<I18nProvider>
				<TaskTmuxControls taskId="task-1" />
			</I18nProvider>,
		);

		const infoButton = screen.getByTitle("tmux Shortcuts");
		const closeButton = screen.getByLabelText("Close pane");

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

		await user.click(screen.getByLabelText("Close pane"));

		expect(onPicker).toHaveBeenCalledTimes(1);
		expect((onPicker.mock.calls[0][0] as CustomEvent).detail).toEqual({ taskId: "task-1" });
		// The picker owns the kill now — the button never touches pane API directly here.
		expect(api.request.taskPaneAction).not.toHaveBeenCalled();
		expect(api.request.taskPaneState).not.toHaveBeenCalled();
		expect(confirm).not.toHaveBeenCalled();

		window.removeEventListener(CLOSE_PANE_PICKER_EVENT, onPicker);
	});

	describe("narrow viewport (direct kill fallback)", () => {
		beforeEach(() => {
			mockNarrow = true;
		});

		it("kills the pane without confirmation when more than one pane exists", async () => {
			const user = userEvent.setup();
			vi.mocked(api.request.taskPaneState).mockResolvedValue(makeState(3));
			vi.mocked(api.request.taskPaneAction).mockResolvedValue(makeState(2));

			render(
				<I18nProvider>
					<TaskTmuxControls taskId="task-1" />
				</I18nProvider>,
			);

			await user.click(screen.getByLabelText("Close pane"));

			await waitFor(() => expect(api.request.taskPaneAction).toHaveBeenCalledWith({
				taskId: "task-1",
				action: { kind: "close" },
			}));
			expect(confirm).not.toHaveBeenCalled();
		});

		it("asks for confirmation only when the active pane is the last one, and forces the kill on accept", async () => {
			const user = userEvent.setup();
			vi.mocked(api.request.taskPaneState).mockResolvedValue(makeState(1));
			vi.mocked(confirm).mockResolvedValue(true);
			vi.mocked(api.request.taskPaneAction).mockResolvedValue(makeState(0));

			render(
				<I18nProvider>
					<TaskTmuxControls taskId="task-1" />
				</I18nProvider>,
			);

			await user.click(screen.getByLabelText("Close pane"));

			expect(confirm).toHaveBeenCalledWith({
				title: "Close the last pane?",
				message: expect.stringContaining("only remaining pane"),
				danger: true,
			});
			await waitFor(() => expect(api.request.taskPaneAction).toHaveBeenCalledWith({
				taskId: "task-1",
				action: { kind: "close", force: true },
			}));
		});

		it("does not kill the last pane when the confirmation is dismissed", async () => {
			const user = userEvent.setup();
			vi.mocked(api.request.taskPaneState).mockResolvedValue(makeState(1));
			vi.mocked(confirm).mockResolvedValue(false);

			render(
				<I18nProvider>
					<TaskTmuxControls taskId="task-1" />
				</I18nProvider>,
			);

			await user.click(screen.getByLabelText("Close pane"));

			expect(confirm).toHaveBeenCalled();
			expect(api.request.taskPaneAction).not.toHaveBeenCalled();
		});
	});

	it("does not prompt for confirmation for non-destructive actions", async () => {
		const user = userEvent.setup();
		vi.mocked(api.request.taskPaneAction).mockResolvedValue(makeState(1));

		render(
			<I18nProvider>
				<TaskTmuxControls taskId="task-1" />
			</I18nProvider>,
		);

		await user.click(screen.getByLabelText("Split horizontally"));

		expect(confirm).not.toHaveBeenCalled();
		expect(api.request.taskPaneState).not.toHaveBeenCalled();
		await waitFor(() => expect(api.request.taskPaneAction).toHaveBeenCalledWith({
			taskId: "task-1",
			action: { kind: "splitH" },
		}));
	});

	it("opens a new tmux window from the green new-window button", async () => {
		const user = userEvent.setup();
		vi.mocked(api.request.tmuxNewWindow).mockResolvedValue(undefined);

		render(
			<I18nProvider>
				<TaskTmuxControls taskId="task-1" />
			</I18nProvider>,
		);

		await user.click(screen.getByLabelText("New window"));

		expect(confirm).not.toHaveBeenCalled();
		await waitFor(() => expect(api.request.tmuxNewWindow).toHaveBeenCalledWith({ taskId: "task-1" }));
	});

	it("cycles layouts from the split-button primary action", async () => {
		const user = userEvent.setup();
		vi.mocked(api.request.taskPaneAction).mockResolvedValue(makeState(2));

		render(
			<I18nProvider>
				<TaskTmuxControls taskId="task-1" />
			</I18nProvider>,
		);

		await user.click(screen.getByLabelText("Cycle layouts"));

		await waitFor(() => expect(api.request.taskPaneAction).toHaveBeenCalledWith({
			taskId: "task-1",
			action: { kind: "layoutCycle" },
		}));
	});

	it("opens the layout menu and applies the chosen preset", async () => {
		const user = userEvent.setup();
		vi.mocked(api.request.taskPaneAction).mockResolvedValue(makeState(2));

		render(
			<I18nProvider>
				<TaskTmuxControls taskId="task-1" />
			</I18nProvider>,
		);

		// Layout presets are hidden behind the dropdown caret, not shown inline.
		expect(screen.queryByText("Tiled (grid)")).not.toBeInTheDocument();

		await user.click(screen.getByLabelText("Choose tmux layout"));

		const tiled = await screen.findByText("Tiled (grid)");
		await user.click(tiled);

		await waitFor(() => expect(api.request.taskPaneAction).toHaveBeenCalledWith({
			taskId: "task-1",
			action: { kind: "layoutPreset", preset: "tiled" },
		}));
	});
});
