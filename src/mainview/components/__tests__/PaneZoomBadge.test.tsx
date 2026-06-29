import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PaneZoomBadge from "../PaneZoomBadge";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			tmuxPaneNavigate: vi.fn(),
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
		vi.mocked(api.request.tmuxPaneNavigate).mockReset();
	});

	it("polls zoom state read-only on mount (no zoom mutation)", async () => {
		vi.mocked(api.request.tmuxPaneNavigate).mockResolvedValue({ count: 2, activeIndex: 0, zoomed: false, labels: ["claude", "bash"] });
		renderBadge();
		await waitFor(() => expect(api.request.tmuxPaneNavigate).toHaveBeenCalled());
		// First call carries no zoom intent — it must not toggle the shared view.
		expect(vi.mocked(api.request.tmuxPaneNavigate).mock.calls[0][0]).toEqual({ taskId: "task-1" });
	});

	it("shows no badge when the window is not zoomed", async () => {
		vi.mocked(api.request.tmuxPaneNavigate).mockResolvedValue({ count: 2, activeIndex: 0, zoomed: false, labels: ["claude", "bash"] });
		renderBadge();
		await waitFor(() => expect(api.request.tmuxPaneNavigate).toHaveBeenCalled());
		expect(screen.queryByLabelText("Show all panes")).toBeNull();
	});

	it("shows no badge for a single-pane session even if flagged zoomed", async () => {
		vi.mocked(api.request.tmuxPaneNavigate).mockResolvedValue({ count: 1, activeIndex: 0, zoomed: true, labels: ["claude"] });
		renderBadge();
		await waitFor(() => expect(api.request.tmuxPaneNavigate).toHaveBeenCalled());
		expect(screen.queryByLabelText("Show all panes")).toBeNull();
	});

	it("shows the badge when a multi-pane window is zoomed", async () => {
		vi.mocked(api.request.tmuxPaneNavigate).mockResolvedValue({ count: 3, activeIndex: 1, zoomed: true, labels: ["claude", "bash", "zsh"] });
		renderBadge();
		await waitFor(() => expect(screen.getByLabelText("Show all panes")).toBeInTheDocument());
		expect(screen.getByLabelText("Show all panes")).toHaveTextContent("Zoomed");
	});

	it("un-zooms when the badge is tapped", async () => {
		vi.mocked(api.request.tmuxPaneNavigate).mockResolvedValue({ count: 3, activeIndex: 1, zoomed: true, labels: ["claude", "bash", "zsh"] });
		renderBadge();
		await waitFor(() => expect(screen.getByLabelText("Show all panes")).toBeInTheDocument());
		await userEvent.click(screen.getByLabelText("Show all panes"));
		expect(api.request.tmuxPaneNavigate).toHaveBeenCalledWith({ taskId: "task-1", zoom: false });
	});
});
