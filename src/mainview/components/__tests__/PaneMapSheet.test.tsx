import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TaskPaneState } from "../../../shared/task-panes";
import PaneMapSheet from "../PaneMapSheet";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";

vi.mock("../../rpc", () => ({
	api: { request: { taskPaneState: vi.fn() } },
}));

function makeState(panes: Array<{ paneId: string; label: string; active: boolean; x: number; y: number; width: number; height: number }>): TaskPaneState {
	return {
		backend: "tmux",
		panes: panes.map((p, i) => ({
			paneId: p.paneId,
			index: i,
			label: p.label,
			active: p.active,
			zoomed: false,
			rect: { x: p.x, y: p.y, width: p.width, height: p.height },
		})),
		activePaneId: panes.find((p) => p.active)?.paneId ?? null,
		zoomedPaneId: null,
		layout: null,
		layoutPreset: null,
		capabilities: ["split", "focus"],
	};
}

// Two side-by-side panes: left takes 49.5%, right takes 50%.
const TWO_PANE_STATE = makeState([
	{ paneId: "%1", label: "claude", active: true, x: 0,     y: 0, width: 0.495, height: 1.0 },
	{ paneId: "%2", label: "zsh",    active: false, x: 0.5,  y: 0, width: 0.5,   height: 1.0 },
]);

function renderSheet(props: Partial<React.ComponentProps<typeof PaneMapSheet>> = {}) {
	const onClose = props.onClose ?? vi.fn();
	const onJump = props.onJump ?? vi.fn();
	render(
		<I18nProvider>
			<PaneMapSheet taskId="task-1" open onClose={onClose} onJump={onJump} {...props} />
		</I18nProvider>,
	);
	return { onClose, onJump };
}

describe("PaneMapSheet", () => {
	beforeEach(() => {
		vi.mocked(api.request.taskPaneState).mockReset();
	});

	it("fetches the layout when opened", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(TWO_PANE_STATE);
		renderSheet();
		await waitFor(() => expect(api.request.taskPaneState).toHaveBeenCalledWith({ taskId: "task-1" }));
	});

	it("does not fetch while closed", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(TWO_PANE_STATE);
		renderSheet({ open: false });
		await Promise.resolve();
		expect(api.request.taskPaneState).not.toHaveBeenCalled();
	});

	it("renders one box per pane, positioned by normalized rect", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(TWO_PANE_STATE);
		renderSheet();

		const active = await screen.findByLabelText("Go to claude");
		const other = screen.getByLabelText("Go to zsh");

		// Geometry from 0..1 rects → CSS percentages
		expect(active.style.left).toBe("0%");
		expect(active.style.width).toBe("49.5%");
		expect(other.style.left).toBe("50%");
		expect(other.style.width).toBe("50%");

		expect(active).toHaveAttribute("aria-current", "true");
		expect(other).not.toHaveAttribute("aria-current");
	});

	it("jumps to the tapped pane by id and closes", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(TWO_PANE_STATE);
		const { onClose, onJump } = renderSheet();

		await userEvent.click(await screen.findByLabelText("Go to zsh"));
		expect(onJump).toHaveBeenCalledWith("%2");
		expect(onClose).toHaveBeenCalled();
	});

	it("shows an empty state when there are no panes", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue({
			backend: "tmux",
			panes: [],
			activePaneId: null,
			zoomedPaneId: null,
			layout: null,
			layoutPreset: null,
			capabilities: [],
		});
		renderSheet();
		expect(await screen.findByText("No panes to show.")).toBeInTheDocument();
	});

	it("does not show a window list (tmux-only concept removed from neutral view)", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(TWO_PANE_STATE);
		renderSheet();
		await screen.findByLabelText("Go to claude");
		expect(screen.queryByText("Windows")).toBeNull();
	});
});
