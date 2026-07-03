import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TmuxLayout } from "../../../shared/types";
import ClosePanePicker from "../ClosePanePicker";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";
import { confirm } from "../../confirm";
import { toast } from "../../toast";
import { startClosePanePicker } from "../../close-pane-picker";

vi.mock("../../rpc", () => ({
	api: { request: { tmuxLayout: vi.fn(), tmuxKillPane: vi.fn() } },
}));
vi.mock("../../confirm", () => ({ confirm: vi.fn() }));
vi.mock("../../toast", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

// Two side-by-side panes in the active window (winW = 200, winH = 50).
const TWO_PANES: TmuxLayout = {
	sessionName: "dev3-task1",
	exists: true,
	windows: [{ index: 0, name: "main", active: true, panes: 2, zoomed: false }],
	panes: [
		{ windowIndex: 0, paneId: "%1", active: true, left: 0, top: 0, width: 99, height: 50, command: "claude", title: "Agent" },
		{ windowIndex: 0, paneId: "%2", active: false, left: 100, top: 0, width: 100, height: 50, command: "zsh", title: "Shell" },
	],
};

const ONE_PANE: TmuxLayout = {
	sessionName: "dev3-task1",
	exists: true,
	windows: [{ index: 0, name: "main", active: true, panes: 1, zoomed: false }],
	panes: [
		{ windowIndex: 0, paneId: "%1", active: true, left: 0, top: 0, width: 200, height: 50, command: "claude", title: "Agent" },
	],
};

const ZOOMED: TmuxLayout = {
	sessionName: "dev3-task1",
	exists: true,
	windows: [{ index: 0, name: "main", active: true, panes: 2, zoomed: true }],
	panes: TWO_PANES.panes,
};

// Two vertically-stacked panes with a 1-cell divider (top 0..28, bottom 30..57)
// over a 58-row window, plus a 1-row bottom status bar → 59-row canvas.
const VSTACK: TmuxLayout = {
	sessionName: "dev3-task1",
	exists: true,
	statusLines: 1,
	statusAtTop: false,
	windows: [{ index: 0, name: "main", active: true, panes: 2, zoomed: false }],
	panes: [
		{ windowIndex: 0, paneId: "%1", active: true, left: 0, top: 0, width: 100, height: 29, command: "claude", title: "Agent" },
		{ windowIndex: 0, paneId: "%2", active: false, left: 0, top: 30, width: 100, height: 28, command: "zsh", title: "Shell" },
	],
};

function renderPicker(taskId = "task-1") {
	render(
		<I18nProvider>
			<ClosePanePicker taskId={taskId} />
		</I18nProvider>,
	);
}

describe("ClosePanePicker", () => {
	beforeEach(() => {
		vi.mocked(api.request.tmuxLayout).mockReset();
		vi.mocked(api.request.tmuxKillPane).mockReset().mockResolvedValue({ killed: true });
		vi.mocked(confirm).mockReset();
		vi.mocked(toast.error).mockReset();
	});

	it("renders nothing until the picker is started", () => {
		vi.mocked(api.request.tmuxLayout).mockResolvedValue(TWO_PANES);
		renderPicker();
		expect(screen.queryByLabelText("Close claude")).toBeNull();
	});

	it("draws one hit-box per pane positioned by geometry when started", async () => {
		vi.mocked(api.request.tmuxLayout).mockResolvedValue(TWO_PANES);
		renderPicker();

		act(() => startClosePanePicker("task-1"));

		const first = await screen.findByLabelText("Close claude");
		const second = screen.getByLabelText("Close zsh");
		// Boxes grow half a cell toward the divider so they TILE with no gap:
		// %1 = [0, 99.5] cells, %2 = [99.5, 200] cells over winW=200.
		expect(parseFloat(first.style.left)).toBeCloseTo(0, 5);
		expect(parseFloat(first.style.width)).toBeCloseTo(49.75, 5);
		expect(parseFloat(second.style.left)).toBeCloseTo(49.75, 5);
		expect(parseFloat(second.style.width)).toBeCloseTo(50.25, 5);
		// The right edge of box 1 meets the left edge of box 2 (no geometry gap).
		const firstRight = parseFloat(first.style.left) + parseFloat(first.style.width);
		expect(firstRight).toBeCloseTo(parseFloat(second.style.left), 5);
	});

	it("offsets vertical geometry by the tmux status bar (bottom panes don't overshoot)", async () => {
		vi.mocked(api.request.tmuxLayout).mockResolvedValue(VSTACK);
		renderPicker();

		act(() => startClosePanePicker("task-1"));
		const top = await screen.findByLabelText("Close claude");
		const bottom = screen.getByLabelText("Close zsh");

		// Boxes tile vertically: top box's bottom edge meets bottom box's top edge.
		const topBottomEdge = parseFloat(top.style.top) + parseFloat(top.style.height);
		expect(topBottomEdge).toBeCloseTo(parseFloat(bottom.style.top), 3);
		// Mapped over the 59-row canvas (58 pane rows + 1 status), so the bottom box
		// stops above the status line instead of reaching 100%.
		const bottomEdge = parseFloat(bottom.style.top) + parseFloat(bottom.style.height);
		expect(bottomEdge).toBeLessThan(100);
		expect(bottomEdge).toBeCloseTo((58 / 59) * 100, 2);
	});

	it("ignores a start event addressed to another task", async () => {
		vi.mocked(api.request.tmuxLayout).mockResolvedValue(TWO_PANES);
		renderPicker("task-1");

		act(() => startClosePanePicker("task-OTHER"));
		await Promise.resolve();
		expect(api.request.tmuxLayout).not.toHaveBeenCalled();
		expect(screen.queryByLabelText("Close claude")).toBeNull();
	});

	it("kills exactly the clicked pane (no force) when several panes exist", async () => {
		vi.mocked(api.request.tmuxLayout).mockResolvedValue(TWO_PANES);
		renderPicker();

		act(() => startClosePanePicker("task-1"));
		await userEvent.click(await screen.findByLabelText("Close zsh"));

		expect(api.request.tmuxKillPane).toHaveBeenCalledWith({ taskId: "task-1", paneId: "%2" });
		expect(confirm).not.toHaveBeenCalled();
	});

	it("confirms then force-kills when the only pane is chosen", async () => {
		vi.mocked(api.request.tmuxLayout).mockResolvedValue(ONE_PANE);
		vi.mocked(confirm).mockResolvedValue(true);
		renderPicker();

		act(() => startClosePanePicker("task-1"));
		await userEvent.click(await screen.findByLabelText("Close claude"));

		expect(confirm).toHaveBeenCalled();
		expect(api.request.tmuxKillPane).toHaveBeenCalledWith({ taskId: "task-1", paneId: "%1", force: true });
	});

	it("does not kill the last pane when the confirm is declined", async () => {
		vi.mocked(api.request.tmuxLayout).mockResolvedValue(ONE_PANE);
		vi.mocked(confirm).mockResolvedValue(false);
		renderPicker();

		act(() => startClosePanePicker("task-1"));
		await userEvent.click(await screen.findByLabelText("Close claude"));

		expect(confirm).toHaveBeenCalled();
		expect(api.request.tmuxKillPane).not.toHaveBeenCalled();
	});

	it("draws a single full-cover hit-box for a zoomed window", async () => {
		vi.mocked(api.request.tmuxLayout).mockResolvedValue(ZOOMED);
		renderPicker();

		act(() => startClosePanePicker("task-1"));

		const box = await screen.findByLabelText("Close claude");
		expect(box.style.width).toBe("100%");
		expect(box.style.height).toBe("100%");
		// The other pane is not addressable while zoomed.
		expect(screen.queryByLabelText("Close zsh")).toBeNull();
	});

	it("toasts and stays closed when the layout cannot be read", async () => {
		vi.mocked(api.request.tmuxLayout).mockResolvedValue({ sessionName: "s", exists: false, windows: [], panes: [] });
		renderPicker();

		act(() => startClosePanePicker("task-1"));
		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		expect(screen.queryByLabelText("Close claude")).toBeNull();
	});

	it("cancels with Escape without killing anything", async () => {
		vi.mocked(api.request.tmuxLayout).mockResolvedValue(TWO_PANES);
		renderPicker();

		act(() => startClosePanePicker("task-1"));
		await screen.findByLabelText("Close claude");
		await userEvent.keyboard("{Escape}");

		await waitFor(() => expect(screen.queryByLabelText("Close claude")).toBeNull());
		expect(api.request.tmuxKillPane).not.toHaveBeenCalled();
	});
});
