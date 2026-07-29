import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MobilePaneCarousel from "../MobilePaneCarousel";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";
import { confirm } from "../../confirm";
import type { TaskPaneState } from "../../../shared/task-panes";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			taskPaneState: vi.fn(),
			taskPaneAction: vi.fn(),
			tmuxNewWindow: vi.fn(),
			tmuxLayout: vi.fn(),
		},
	},
}));

vi.mock("../../confirm", () => ({
	confirm: vi.fn(),
}));

function makeState(count: number, activeIndex = 0, zoomed = false, labels?: string[]): TaskPaneState {
	const paneLabels = labels ?? Array.from({ length: count }, (_, i) => ["claude", "bash", "zsh"][i] ?? `pane-${i + 1}`);
	return {
		backend: "tmux",
		panes: Array.from({ length: count }, (_, i) => ({
			paneId: `%${i + 1}`,
			index: i,
			label: paneLabels[i] ?? "",
			active: i === activeIndex,
			zoomed: zoomed && i === activeIndex,
			rect: { x: 0, y: 0, width: 1, height: 1 },
		})),
		activePaneId: count > 0 ? `%${activeIndex + 1}` : null,
		zoomedPaneId: zoomed && count > 0 ? `%${activeIndex + 1}` : null,
		layout: null,
		layoutPreset: null,
		capabilities: ["split"],
	};
}

const LAYOUT = {
	sessionName: "dev3-task1",
	exists: true,
	windows: [{ index: 0, name: "main", active: true, panes: 2, zoomed: false }],
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
		vi.mocked(api.request.taskPaneState).mockReset();
		vi.mocked(api.request.taskPaneAction).mockReset();
		vi.mocked(api.request.tmuxNewWindow).mockReset();
		vi.mocked(api.request.tmuxLayout).mockReset();
		vi.mocked(api.request.taskPaneAction).mockResolvedValue(makeState(2, 0, true));
		vi.mocked(api.request.tmuxNewWindow).mockResolvedValue(undefined);
		vi.mocked(confirm).mockReset();
		vi.mocked(confirm).mockResolvedValue(true);
	});

	it("always renders the terminal children", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(makeState(1));
		renderCarousel();
		expect(screen.getByTestId("terminal-body")).toBeInTheDocument();
		await waitFor(() => expect(api.request.taskPaneState).toHaveBeenCalled());
	});

	it("shows no switcher for a single-pane session", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(makeState(1));
		renderCarousel();
		await waitFor(() => expect(api.request.taskPaneState).toHaveBeenCalled());
		expect(screen.queryByLabelText("Switch pane")).toBeNull();
		expect(screen.queryByLabelText("Next pane")).toBeNull();
	});

	it("auto-zooms on mount and shows chevrons + the named dropdown for a multi-pane session", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(makeState(3, 0, true));
		renderCarousel();
		await waitFor(() => expect(screen.getByLabelText("Switch pane")).toBeInTheDocument());
		expect(screen.getByLabelText("Previous pane")).toBeInTheDocument();
		expect(screen.getByLabelText("Next pane")).toBeInTheDocument();
		// First call is the mount auto-zoom.
		expect(vi.mocked(api.request.taskPaneAction).mock.calls[0][0]).toMatchObject({
			taskId: "task-1",
			action: { kind: "zoom", mode: "on" },
		});
	});

	it("the dropdown lists named panes and jumps to one by index", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(makeState(3, 0, true));
		renderCarousel();
		await waitFor(() => expect(screen.getByLabelText("Switch pane")).toBeInTheDocument());

		await userEvent.click(screen.getByLabelText("Switch pane"));
		const options = screen.getAllByRole("option");
		expect(options).toHaveLength(3);
		expect(options[1]).toHaveTextContent("bash");

		await userEvent.click(screen.getByRole("option", { name: /zsh/ }));
		await waitFor(() => expect(api.request.taskPaneAction).toHaveBeenCalledWith(expect.objectContaining({
			taskId: "task-1",
			action: { kind: "focus", paneId: "%3" },
		})));
	});

	it("the pane overview button opens a spatial map that jumps by pane id", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(makeState(2, 0, true));
		vi.mocked(api.request.tmuxLayout).mockResolvedValue(LAYOUT);
		renderCarousel();
		await waitFor(() => expect(screen.getByLabelText("Pane overview")).toBeInTheDocument());

		await userEvent.click(screen.getByLabelText("Pane overview"));
		await waitFor(() => expect(api.request.tmuxLayout).toHaveBeenCalledWith({ taskId: "task-1" }));

		await userEvent.click(await screen.findByLabelText("Go to zsh"));
		await waitFor(() => expect(api.request.taskPaneAction).toHaveBeenCalledWith(expect.objectContaining({
			taskId: "task-1",
			action: { kind: "focus", paneId: "%2" },
		})));
	});

	it("no pane overview button for a single-pane session", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(makeState(1));
		renderCarousel();
		await waitFor(() => expect(api.request.taskPaneState).toHaveBeenCalled());
		expect(screen.queryByLabelText("Pane overview")).toBeNull();
	});

	it("chevron buttons move between panes with keep-zoom", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(makeState(3, 0, true));
		renderCarousel();
		await waitFor(() => expect(screen.getByLabelText("Next pane")).toBeInTheDocument());
		await userEvent.click(screen.getByLabelText("Next pane"));
		await waitFor(() => expect(api.request.taskPaneAction).toHaveBeenCalledWith(expect.objectContaining({
			taskId: "task-1",
			action: { kind: "focusStep", step: "next" },
		})));
		await userEvent.click(screen.getByLabelText("Previous pane"));
		await waitFor(() => expect(api.request.taskPaneAction).toHaveBeenCalledWith(expect.objectContaining({
			taskId: "task-1",
			action: { kind: "focusStep", step: "prev" },
		})));
	});

	it("Arrow keys move between panes with keep-zoom", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(makeState(3, 0, true));
		renderCarousel();
		await waitFor(() => expect(screen.getByLabelText("Switch pane")).toBeInTheDocument());
		const group = screen.getByRole("group");
		group.focus();
		await userEvent.keyboard("{ArrowRight}");
		await waitFor(() => expect(api.request.taskPaneAction).toHaveBeenCalledWith(expect.objectContaining({
			taskId: "task-1",
			action: { kind: "focusStep", step: "next" },
		})));
	});

	it("a left swipe over the terminal advances to the next pane", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(makeState(3, 0, true));
		renderCarousel();
		await waitFor(() => expect(screen.getByLabelText("Switch pane")).toBeInTheDocument());
		const surface = screen.getByTestId("pane-carousel-surface");
		vi.mocked(api.request.taskPaneAction).mockClear();

		touch(surface, "touchstart", 240, 200);
		touch(surface, "touchmove", 150, 205);
		touch(surface, "touchmove", 120, 205);
		touch(surface, "touchend", 120, 205);

		await waitFor(() =>
			expect(api.request.taskPaneAction).toHaveBeenCalledWith(expect.objectContaining({
				taskId: "task-1",
				action: { kind: "focusStep", step: "next" },
			})),
		);
	});

	it("a vertical drag does not change panes", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(makeState(3, 0, true));
		renderCarousel();
		await waitFor(() => expect(screen.getByLabelText("Switch pane")).toBeInTheDocument());
		const surface = screen.getByTestId("pane-carousel-surface");
		vi.mocked(api.request.taskPaneAction).mockClear();

		touch(surface, "touchstart", 200, 100);
		touch(surface, "touchmove", 205, 220);
		touch(surface, "touchend", 205, 220);

		await Promise.resolve();
		expect(vi.mocked(api.request.taskPaneAction).mock.calls.filter(
			(c) => c[0].action.kind === "focusStep",
		)).toHaveLength(0);
	});

	it("exposes the Panes & windows button even on a single-pane session", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(makeState(1));
		renderCarousel();
		await waitFor(() => expect(screen.getByLabelText("Panes & windows")).toBeInTheDocument());
		expect(screen.queryByLabelText("Switch pane")).toBeNull();
	});

	it("the sheet splits the pane and immediately refreshes the layout", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(makeState(1));
		renderCarousel();
		await waitFor(() => expect(screen.getByLabelText("Panes & windows")).toBeInTheDocument());

		await userEvent.click(screen.getByLabelText("Panes & windows"));
		await userEvent.click(screen.getByRole("button", { name: "Split vertically" }));

		await waitFor(() => expect(api.request.taskPaneAction).toHaveBeenCalledWith(expect.objectContaining({
			taskId: "task-1",
			action: { kind: "splitV" },
		})));
	});

	it("the sheet opens a new tmux window", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(makeState(1));
		renderCarousel();
		await waitFor(() => expect(screen.getByLabelText("Panes & windows")).toBeInTheDocument());

		await userEvent.click(screen.getByLabelText("Panes & windows"));
		await userEvent.click(screen.getByRole("button", { name: "New window" }));

		await waitFor(() => expect(api.request.tmuxNewWindow).toHaveBeenCalledWith({ taskId: "task-1" }));
	});

	it("closing the only pane confirms first, then force-closes", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(makeState(1));
		vi.mocked(confirm).mockResolvedValue(true);
		renderCarousel();
		await waitFor(() => expect(screen.getByLabelText("Panes & windows")).toBeInTheDocument());

		await userEvent.click(screen.getByLabelText("Panes & windows"));
		await userEvent.click(screen.getByRole("button", { name: "Close pane" }));

		await waitFor(() => expect(confirm).toHaveBeenCalled());
		await waitFor(() => expect(api.request.taskPaneAction).toHaveBeenCalledWith(expect.objectContaining({
			taskId: "task-1",
			action: { kind: "close", force: true },
		})));
	});

	it("declining the last-pane confirm does not close the pane", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(makeState(1));
		vi.mocked(confirm).mockResolvedValue(false);
		renderCarousel();
		await waitFor(() => expect(screen.getByLabelText("Panes & windows")).toBeInTheDocument());

		await userEvent.click(screen.getByLabelText("Panes & windows"));
		await userEvent.click(screen.getByRole("button", { name: "Close pane" }));

		await waitFor(() => expect(confirm).toHaveBeenCalled());
		const closeCalls = vi.mocked(api.request.taskPaneAction).mock.calls.filter(
			(c) => c[0].action.kind === "close",
		);
		expect(closeCalls).toHaveLength(0);
	});

	it("a changed refreshKey re-reads + re-zooms the new window's panes", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(makeState(3, 0, true));
		const { rerender } = render(
			<I18nProvider>
				<MobilePaneCarousel taskId="task-1" refreshKey={0}>
					<div data-testid="terminal-body">term</div>
				</MobilePaneCarousel>
			</I18nProvider>,
		);
		await waitFor(() => expect(api.request.taskPaneState).toHaveBeenCalled());
		vi.mocked(api.request.taskPaneAction).mockClear();

		rerender(
			<I18nProvider>
				<MobilePaneCarousel taskId="task-1" refreshKey={1}>
					<div data-testid="terminal-body">term</div>
				</MobilePaneCarousel>
			</I18nProvider>,
		);
		await waitFor(() =>
			expect(api.request.taskPaneAction).toHaveBeenCalledWith(expect.objectContaining({
				taskId: "task-1",
				action: { kind: "zoom", mode: "on" },
			})),
		);
	});
});
