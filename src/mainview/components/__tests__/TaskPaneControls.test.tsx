import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import TaskPaneControls from "../task-info-panel/TaskPaneControls";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";
import { confirm } from "../../confirm";
import { CLOSE_PANE_PICKER_EVENT } from "../../close-pane-picker";
import { _resetPaneStateBus, subscribePaneState } from "../../pane-state-bus";
import type { TaskPaneState } from "../../../shared/task-panes";

function makeState(
	count: number,
	opts: { backend?: "tmux" | "native"; capabilities?: string[] } = {},
): TaskPaneState {
	const backend = opts.backend ?? "tmux";
	const defaultCaps: TaskPaneState["capabilities"] = count > 1
		? ["split", "zoom", "close", "focus", "focusDirection", "layoutPreset", "layoutCycle", ...(backend === "tmux" ? ["newWindow" as const] : [])]
		: ["split", "zoom", "close", ...(backend === "tmux" ? ["newWindow" as const] : [])];
	return {
		backend,
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
		capabilities: (opts.capabilities as TaskPaneState["capabilities"]) ?? defaultCaps,
	};
}

const TMUX_ONE_PANE = makeState(1, { backend: "tmux" });
const TMUX_TWO_PANE = makeState(2, { backend: "tmux" });
const NATIVE_TWO_PANE = makeState(2, { backend: "native" });

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

let mockNarrow = false;
vi.mock("../../hooks/useNarrowViewport", () => ({
	useNarrowViewport: () => mockNarrow,
}));

function renderControls(taskId = "task-1") {
	return render(
		<I18nProvider>
			<TaskPaneControls taskId={taskId} />
		</I18nProvider>,
	);
}

describe("TaskPaneControls", () => {
	beforeEach(() => {
		localStorage.clear();
		_resetPaneStateBus();
		mockNarrow = false;
		vi.mocked(api.request.taskPaneAction).mockReset();
		vi.mocked(api.request.taskPaneState).mockReset().mockResolvedValue(TMUX_TWO_PANE);
		vi.mocked(api.request.tmuxNewWindow).mockReset();
		vi.mocked(confirm).mockReset();
	});

	// ── tmux task: standard controls ─────────────────────────────────────────

	it("shows split, layout, zoom and close controls for a tmux task", async () => {
		renderControls();
		await waitFor(() => expect(api.request.taskPaneState).toHaveBeenCalled());
		expect(screen.getByLabelText("Split horizontally")).toBeInTheDocument();
		expect(screen.getByLabelText("Split vertically")).toBeInTheDocument();
		expect(screen.getByLabelText("Zoom pane (toggle)")).toBeInTheDocument();
		expect(screen.getByLabelText("Close pane")).toBeInTheDocument();
	});

	it("renders the new-window button for a tmux task with the capability", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(TMUX_TWO_PANE);
		renderControls();
		await waitFor(() => expect(screen.queryByLabelText("New window")).toBeInTheDocument());
	});

	it("does NOT render new-window for a native task (capability absent)", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(NATIVE_TWO_PANE);
		renderControls();
		await waitFor(() => expect(api.request.taskPaneState).toHaveBeenCalled());
		// Give React time to update
		await new Promise((r) => setTimeout(r, 20));
		expect(screen.queryByLabelText("New window")).not.toBeInTheDocument();
	});

	// ── Single pane: layout / zoom / close are not rendered at all ────────────

	it("hides layout, zoom and close for a single-pane task", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(TMUX_ONE_PANE);
		renderControls();
		await waitFor(() => expect(api.request.taskPaneState).toHaveBeenCalled());
		await new Promise((r) => setTimeout(r, 20));
		expect(screen.queryByLabelText("Cycle layouts")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Choose pane layout")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Zoom pane (toggle)")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Close pane")).not.toBeInTheDocument();
		// The controls that still make sense on one pane stay.
		expect(screen.getByLabelText("Split horizontally")).toBeInTheDocument();
		expect(screen.getByLabelText("Split vertically")).toBeInTheDocument();
		expect(screen.getByLabelText("New window")).toBeInTheDocument();
	});

	it("hides layout, zoom and close until the pane state has loaded", () => {
		vi.mocked(api.request.taskPaneState).mockReturnValue(new Promise<TaskPaneState>(() => {}));
		renderControls();
		expect(screen.queryByLabelText("Cycle layouts")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Zoom pane (toggle)")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Close pane")).not.toBeInTheDocument();
	});

	it("enables the layout button with 2+ panes", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(TMUX_TWO_PANE);
		renderControls();
		await waitFor(() => expect(api.request.taskPaneState).toHaveBeenCalled());
		await new Promise((r) => setTimeout(r, 20));
		const layoutBtn = screen.getByLabelText("Cycle layouts");
		expect(layoutBtn).not.toBeDisabled();
	});

	// ── Close pane: desktop picker vs narrow direct kill ─────────────────────

	it("opens the two-step pane picker instead of killing directly (desktop split)", async () => {
		const user = userEvent.setup();
		const onPicker = vi.fn();
		window.addEventListener(CLOSE_PANE_PICKER_EVENT, onPicker);

		renderControls();

		await user.click(await screen.findByLabelText("Close pane"));

		expect(onPicker).toHaveBeenCalledTimes(1);
		expect((onPicker.mock.calls[0][0] as CustomEvent).detail).toEqual({ taskId: "task-1" });
		expect(api.request.taskPaneAction).not.toHaveBeenCalled();
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

			renderControls();

			await user.click(await screen.findByLabelText("Close pane"));

			await waitFor(() => expect(api.request.taskPaneAction).toHaveBeenCalledWith({
				taskId: "task-1",
				action: { kind: "close" },
			}));
			expect(confirm).not.toHaveBeenCalled();
		});

		it("offers no close control for a single-pane task, so the last pane cannot be killed here", async () => {
			vi.mocked(api.request.taskPaneState).mockResolvedValue(makeState(1));

			renderControls();
			await waitFor(() => expect(api.request.taskPaneState).toHaveBeenCalled());
			await new Promise((r) => setTimeout(r, 20));

			expect(screen.queryByLabelText("Close pane")).not.toBeInTheDocument();
			expect(confirm).not.toHaveBeenCalled();
		});
	});

	// ── Action handlers ───────────────────────────────────────────────────────

	it("targets the viewer-focused pane on native, not the server-active one", async () => {
		const user = userEvent.setup();
		const { publishNativePaneFocus, _resetNativePaneFocus } = await import("../../native-pane-focus");
		_resetNativePaneFocus();
		publishNativePaneFocus("task-1", "pane-2");
		vi.mocked(api.request.taskPaneState).mockResolvedValue(NATIVE_TWO_PANE);
		vi.mocked(api.request.taskPaneAction).mockResolvedValue(NATIVE_TWO_PANE);

		renderControls();
		await waitFor(() => expect(api.request.taskPaneState).toHaveBeenCalled());
		await user.click(screen.getByLabelText("Zoom pane (toggle)"));

		await waitFor(() => expect(api.request.taskPaneAction).toHaveBeenCalledWith({
			taskId: "task-1",
			action: { kind: "zoom", mode: "toggle", paneId: "pane-2" },
		}));
		_resetNativePaneFocus();
	});

	it("sends splitH action without prompting", async () => {
		const user = userEvent.setup();
		vi.mocked(api.request.taskPaneAction).mockResolvedValue(TMUX_TWO_PANE);

		renderControls();

		await user.click(screen.getByLabelText("Split horizontally"));

		expect(confirm).not.toHaveBeenCalled();
		await waitFor(() => expect(api.request.taskPaneAction).toHaveBeenCalledWith({
			taskId: "task-1",
			action: { kind: "splitH" },
		}));
	});

	it("sends splitV action", async () => {
		const user = userEvent.setup();
		vi.mocked(api.request.taskPaneAction).mockResolvedValue(TMUX_TWO_PANE);

		renderControls();

		await user.click(screen.getByLabelText("Split vertically"));

		await waitFor(() => expect(api.request.taskPaneAction).toHaveBeenCalledWith({
			taskId: "task-1",
			action: { kind: "splitV" },
		}));
	});

	it("opens a new tmux window from the green new-window button", async () => {
		const user = userEvent.setup();
		vi.mocked(api.request.taskPaneState).mockResolvedValue(TMUX_TWO_PANE);
		vi.mocked(api.request.tmuxNewWindow).mockResolvedValue(undefined);

		renderControls();
		// Wait for the new window button to appear (requires capability to load).
		const btn = await screen.findByLabelText("New window");
		await user.click(btn);

		expect(confirm).not.toHaveBeenCalled();
		await waitFor(() => expect(api.request.tmuxNewWindow).toHaveBeenCalledWith({ taskId: "task-1" }));
	});

	it("cycles layouts from the primary cycle button (enabled at 2+ panes)", async () => {
		const user = userEvent.setup();
		vi.mocked(api.request.taskPaneState).mockResolvedValue(TMUX_TWO_PANE);
		vi.mocked(api.request.taskPaneAction).mockResolvedValue(TMUX_TWO_PANE);

		renderControls();
		await waitFor(() => expect(api.request.taskPaneState).toHaveBeenCalled());
		await new Promise((r) => setTimeout(r, 20));

		await user.click(screen.getByLabelText("Cycle layouts"));

		await waitFor(() => expect(api.request.taskPaneAction).toHaveBeenCalledWith({
			taskId: "task-1",
			action: { kind: "layoutCycle" },
		}));
	});

	// ── Immediate feedback + duplicate suppression (seq 1382) ─────────────────

	it("holds every mutating control while a split is in flight, then releases them", async () => {
		const user = userEvent.setup();
		let releaseAction!: (state: TaskPaneState) => void;
		vi.mocked(api.request.taskPaneAction).mockReturnValue(
			new Promise<TaskPaneState>((resolve) => { releaseAction = resolve; }),
		);
		vi.mocked(api.request.taskPaneState).mockResolvedValue(TMUX_TWO_PANE);
		renderControls();
		await waitFor(() => expect(screen.getByLabelText("Cycle layouts")).not.toBeDisabled());

		await user.click(screen.getByLabelText("Split horizontally"));

		expect(screen.getByLabelText("Split horizontally")).toBeDisabled();
		expect(screen.getByLabelText("Split vertically")).toBeDisabled();
		expect(screen.getByLabelText("Zoom pane (toggle)")).toBeDisabled();
		expect(screen.getByLabelText("Cycle layouts")).toBeDisabled();
		expect(screen.getByLabelText("Close pane")).toBeDisabled();

		releaseAction(TMUX_TWO_PANE);
		await waitFor(() => expect(screen.getByLabelText("Split horizontally")).not.toBeDisabled());
	});

	it("issues exactly one action for a double click on split", async () => {
		const user = userEvent.setup();
		let releaseAction!: (state: TaskPaneState) => void;
		vi.mocked(api.request.taskPaneAction).mockReturnValue(
			new Promise<TaskPaneState>((resolve) => { releaseAction = resolve; }),
		);
		vi.mocked(api.request.taskPaneState).mockResolvedValue(TMUX_TWO_PANE);
		renderControls();
		await waitFor(() => expect(screen.getByLabelText("Cycle layouts")).not.toBeDisabled());

		await user.dblClick(screen.getByLabelText("Split horizontally"));

		expect(api.request.taskPaneAction).toHaveBeenCalledTimes(1);
		releaseAction(TMUX_TWO_PANE);
	});

	it("marks the control group busy while an action runs", async () => {
		const user = userEvent.setup();
		vi.mocked(api.request.taskPaneAction).mockReturnValue(new Promise<TaskPaneState>(() => {}));
		vi.mocked(api.request.taskPaneState).mockResolvedValue(TMUX_TWO_PANE);
		renderControls();
		await waitFor(() => expect(screen.getByLabelText("Cycle layouts")).not.toBeDisabled());
		const group = screen.getByLabelText("Split horizontally").closest("[aria-busy]")!;
		expect(group).toHaveAttribute("aria-busy", "false");

		await user.click(screen.getByLabelText("Split horizontally"));

		expect(group).toHaveAttribute("aria-busy", "true");
	});

	it("broadcasts the action's own response so other pane subscribers see it at once", async () => {
		const user = userEvent.setup();
		const nextState = makeState(3, { backend: "native" });
		vi.mocked(api.request.taskPaneAction).mockResolvedValue(nextState);
		vi.mocked(api.request.taskPaneState).mockResolvedValue(NATIVE_TWO_PANE);
		renderControls();
		await waitFor(() => expect(screen.getByLabelText("Cycle layouts")).not.toBeDisabled());
		const seen = vi.fn();
		const stop = subscribePaneState("task-1", seen);

		await user.click(screen.getByLabelText("Split horizontally"));

		await waitFor(() => expect(seen).toHaveBeenCalledWith(nextState));
		stop();
	});

	it("carries no shortcuts button — that moved next to the panel chrome", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(TMUX_TWO_PANE);
		renderControls();
		await waitFor(() => expect(api.request.taskPaneState).toHaveBeenCalled());
		await new Promise((r) => setTimeout(r, 20));
		expect(screen.queryByTitle("tmux Shortcuts")).not.toBeInTheDocument();
	});
});
