import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PaneZoomBadge from "../PaneZoomBadge";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";

const makeState = (zoomed: boolean, count: number) => ({
	backend: "tmux" as const,
	panes: Array.from({ length: count }, (_, i) => ({
		paneId: `%${i + 1}`,
		index: i,
		label: "",
		active: i === 0,
		zoomed: zoomed && i === 0,
		rect: { x: 0, y: 0, width: 1, height: 1 },
	})),
	activePaneId: "%1",
	zoomedPaneId: zoomed ? "%1" : null,
	layout: null,
	layoutPreset: null,
	capabilities: ["split" as const],
});

vi.mock("../../rpc", () => ({
	api: {
		request: {
			taskPaneState: vi.fn(),
			taskPaneAction: vi.fn(),
		},
	},
}));

function renderBadge(taskId = "task-1") {
	return render(
		<I18nProvider>
			<PaneZoomBadge taskId={taskId} />
		</I18nProvider>,
	);
}

describe("PaneZoomBadge", () => {
	beforeEach(() => {
		vi.mocked(api.request.taskPaneState).mockReset();
		vi.mocked(api.request.taskPaneAction).mockReset();
	});

	it("polls zoom state read-only on mount (no zoom mutation)", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(makeState(false, 2));
		renderBadge();
		await waitFor(() => expect(api.request.taskPaneState).toHaveBeenCalled());
		expect(vi.mocked(api.request.taskPaneAction)).not.toHaveBeenCalled();
	});

	it("shows no badge when the window is not zoomed", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(makeState(false, 2));
		renderBadge();
		await waitFor(() => expect(api.request.taskPaneState).toHaveBeenCalled());
		expect(screen.queryByLabelText("Show all panes")).toBeNull();
	});

	it("shows no badge for a single-pane session even if flagged zoomed", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(makeState(true, 1));
		renderBadge();
		await waitFor(() => expect(api.request.taskPaneState).toHaveBeenCalled());
		expect(screen.queryByLabelText("Show all panes")).toBeNull();
	});

	it("shows the badge when a multi-pane window is zoomed", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(makeState(true, 3));
		renderBadge();
		await waitFor(() => expect(screen.getByLabelText("Show all panes")).toBeInTheDocument());
		expect(screen.getByLabelText("Show all panes")).toHaveTextContent("Zoomed");
	});

	it("un-zooms when the badge is tapped", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(makeState(true, 3));
		vi.mocked(api.request.taskPaneAction).mockResolvedValue(makeState(false, 3));
		renderBadge();
		await waitFor(() => expect(screen.getByLabelText("Show all panes")).toBeInTheDocument());
		await userEvent.click(screen.getByLabelText("Show all panes"));
		expect(api.request.taskPaneAction).toHaveBeenCalledWith({
			taskId: "task-1",
			action: { kind: "zoom", mode: "off" },
		});
	});
});
