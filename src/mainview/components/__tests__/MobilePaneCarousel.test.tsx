import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MobilePaneCarousel from "../MobilePaneCarousel";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			tmuxPaneNavigate: vi.fn(),
			tmuxLayout: vi.fn(),
		},
	},
}));

const THREE_PANES = { count: 3, activeIndex: 0, zoomed: true, labels: ["claude", "bash", "zsh"] };

const LAYOUT = {
	sessionName: "dev3-task1",
	exists: true,
	windows: [{ index: 0, name: "main", active: true, panes: 2 }],
	panes: [
		{ windowIndex: 0, paneId: "%1", active: true, left: 0, top: 0, width: 99, height: 50, command: "claude", title: "Agent" },
		{ windowIndex: 0, paneId: "%2", active: false, left: 100, top: 0, width: 100, height: 50, command: "zsh", title: "Shell" },
	],
};

function renderCarousel(taskId = "task-1") {
	return render(
		<I18nProvider>
			<MobilePaneCarousel taskId={taskId}>
				<div data-testid="terminal-body">term</div>
			</MobilePaneCarousel>
		</I18nProvider>,
	);
}

/** Dispatch a synthetic touch event carrying a single touch point. */
function touch(el: Element, type: string, x: number, y: number) {
	const ev = new Event(type, { bubbles: true, cancelable: true });
	const point = { clientX: x, clientY: y };
	Object.defineProperty(ev, "touches", { value: type === "touchend" ? [] : [point] });
	Object.defineProperty(ev, "changedTouches", { value: [point] });
	el.dispatchEvent(ev);
}

describe("MobilePaneCarousel", () => {
	beforeEach(() => {
		vi.mocked(api.request.tmuxPaneNavigate).mockReset();
		vi.mocked(api.request.tmuxLayout).mockReset();
	});

	it("always renders the terminal children", async () => {
		vi.mocked(api.request.tmuxPaneNavigate).mockResolvedValue({ count: 1, activeIndex: 0, zoomed: false, labels: ["claude"] });
		renderCarousel();
		expect(screen.getByTestId("terminal-body")).toBeInTheDocument();
		await waitFor(() => expect(api.request.tmuxPaneNavigate).toHaveBeenCalled());
	});

	it("shows no switcher for a single-pane session", async () => {
		vi.mocked(api.request.tmuxPaneNavigate).mockResolvedValue({ count: 1, activeIndex: 0, zoomed: false, labels: ["claude"] });
		renderCarousel();
		await waitFor(() => expect(api.request.tmuxPaneNavigate).toHaveBeenCalled());
		expect(screen.queryByLabelText("Switch pane")).toBeNull();
		expect(screen.queryByLabelText("Next pane")).toBeNull();
	});

	it("auto-zooms on mount and shows chevrons + the named dropdown for a multi-pane session", async () => {
		vi.mocked(api.request.tmuxPaneNavigate).mockResolvedValue(THREE_PANES);
		renderCarousel();
		await waitFor(() => expect(screen.getByLabelText("Switch pane")).toBeInTheDocument());
		expect(screen.getByLabelText("Previous pane")).toBeInTheDocument();
		expect(screen.getByLabelText("Next pane")).toBeInTheDocument();
		// Trigger shows the active pane's name.
		expect(screen.getByLabelText("Switch pane")).toHaveTextContent("1. claude");
		// First call is the mount auto-zoom: pure zoom intent, no navigation.
		expect(vi.mocked(api.request.tmuxPaneNavigate).mock.calls[0][0]).toEqual({ taskId: "task-1", zoom: true });
	});

	it("the dropdown lists named panes and jumps to one by index", async () => {
		vi.mocked(api.request.tmuxPaneNavigate).mockResolvedValue(THREE_PANES);
		renderCarousel();
		await waitFor(() => expect(screen.getByLabelText("Switch pane")).toBeInTheDocument());

		await userEvent.click(screen.getByLabelText("Switch pane"));
		const options = screen.getAllByRole("option");
		expect(options).toHaveLength(3);
		expect(options[1]).toHaveTextContent("bash");

		await userEvent.click(screen.getByRole("option", { name: /zsh/ }));
		expect(api.request.tmuxPaneNavigate).toHaveBeenCalledWith({ taskId: "task-1", index: 2, zoom: true });
	});

	it("the pane overview button opens a spatial map that jumps by pane id", async () => {
		vi.mocked(api.request.tmuxPaneNavigate).mockResolvedValue(THREE_PANES);
		vi.mocked(api.request.tmuxLayout).mockResolvedValue(LAYOUT);
		renderCarousel();
		await waitFor(() => expect(screen.getByLabelText("Pane overview")).toBeInTheDocument());

		await userEvent.click(screen.getByLabelText("Pane overview"));
		await waitFor(() => expect(api.request.tmuxLayout).toHaveBeenCalledWith({ taskId: "task-1" }));

		await userEvent.click(await screen.findByLabelText("Go to zsh"));
		expect(api.request.tmuxPaneNavigate).toHaveBeenCalledWith({ taskId: "task-1", paneId: "%2", zoom: true });
	});

	it("no pane overview button for a single-pane session", async () => {
		vi.mocked(api.request.tmuxPaneNavigate).mockResolvedValue({ count: 1, activeIndex: 0, zoomed: false, labels: ["claude"] });
		renderCarousel();
		await waitFor(() => expect(api.request.tmuxPaneNavigate).toHaveBeenCalled());
		expect(screen.queryByLabelText("Pane overview")).toBeNull();
	});

	it("chevron buttons move between panes with keep-zoom", async () => {
		vi.mocked(api.request.tmuxPaneNavigate).mockResolvedValue(THREE_PANES);
		renderCarousel();
		await waitFor(() => expect(screen.getByLabelText("Next pane")).toBeInTheDocument());
		await userEvent.click(screen.getByLabelText("Next pane"));
		expect(api.request.tmuxPaneNavigate).toHaveBeenCalledWith({ taskId: "task-1", step: "next", zoom: true });
		await userEvent.click(screen.getByLabelText("Previous pane"));
		expect(api.request.tmuxPaneNavigate).toHaveBeenCalledWith({ taskId: "task-1", step: "prev", zoom: true });
	});

	it("Arrow keys move between panes with keep-zoom", async () => {
		vi.mocked(api.request.tmuxPaneNavigate).mockResolvedValue(THREE_PANES);
		renderCarousel();
		await waitFor(() => expect(screen.getByLabelText("Switch pane")).toBeInTheDocument());
		const group = screen.getByRole("group");
		group.focus();
		await userEvent.keyboard("{ArrowRight}");
		expect(api.request.tmuxPaneNavigate).toHaveBeenCalledWith({ taskId: "task-1", step: "next", zoom: true });
	});

	it("a left swipe over the terminal advances to the next pane", async () => {
		vi.mocked(api.request.tmuxPaneNavigate).mockResolvedValue(THREE_PANES);
		renderCarousel();
		await waitFor(() => expect(screen.getByLabelText("Switch pane")).toBeInTheDocument());
		const surface = screen.getByTestId("pane-carousel-surface");
		vi.mocked(api.request.tmuxPaneNavigate).mockClear();

		touch(surface, "touchstart", 240, 200);
		touch(surface, "touchmove", 150, 205); // clearly horizontal
		touch(surface, "touchmove", 120, 205); // past commit threshold
		touch(surface, "touchend", 120, 205);

		await waitFor(() =>
			expect(api.request.tmuxPaneNavigate).toHaveBeenCalledWith({ taskId: "task-1", step: "next", zoom: true }),
		);
	});

	it("a vertical drag does not change panes (left to the terminal)", async () => {
		vi.mocked(api.request.tmuxPaneNavigate).mockResolvedValue(THREE_PANES);
		renderCarousel();
		await waitFor(() => expect(screen.getByLabelText("Switch pane")).toBeInTheDocument());
		const surface = screen.getByTestId("pane-carousel-surface");
		vi.mocked(api.request.tmuxPaneNavigate).mockClear();

		touch(surface, "touchstart", 200, 100);
		touch(surface, "touchmove", 205, 220); // clearly vertical
		touch(surface, "touchend", 205, 220);

		await Promise.resolve();
		expect(api.request.tmuxPaneNavigate).not.toHaveBeenCalled();
	});
});
