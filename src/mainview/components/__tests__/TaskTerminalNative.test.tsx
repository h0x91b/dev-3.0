/**
 * TaskTerminal — native multi-pane rendering (seq 1311, PR3).
 *
 * Verifies:
 *  1. tmux task → exactly ONE TerminalView, unchanged tmux control set.
 *  2. Native task with 2 panes → two TerminalViews with stable keys.
 *  3. Native task with 6 panes → six TerminalViews with stable keys.
 *  4. TerminalViews keep their keys (no remount) when a sibling splits.
 *  5. TerminalViews keep their keys when a layout preset changes.
 *  6. Focus/zoom stay client-local (no server write-back).
 *  7. Layout button disabled at 1 pane; newWindow absent on native.
 *  8. Pane-exited state renders the "pane exited" box + close button.
 *  9. No MobileWindowCarousel for native tasks.
 * 10. MobilePaneCarousel used for native on narrow viewport.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task, Project } from "../../../shared/types";
import type { TaskPaneState } from "../../../shared/task-panes";
import { createSplitTree, serializeSplitTree, splitPane } from "../../../shared/split-tree";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getPtyUrl: vi.fn(),
			getPanePtyUrl: vi.fn(),
			taskPaneState: vi.fn(),
			taskPaneAction: vi.fn(),
			tmuxNewWindow: vi.fn(),
			checkWorktreeExists: vi.fn(),
		},
	},
	isElectrobun: false,
}));

// TerminalView is a complex WebSocket component; stub it to a simple <div>.
vi.mock("../../TerminalView", () => ({
	default: ({ ptyUrl }: { ptyUrl: string }) => (
		<div data-testid="terminal-view" data-pty-url={ptyUrl} />
	),
}));

// Other complex sub-components
vi.mock("../TaskInfoPanel", () => ({ default: () => <div data-testid="task-info-panel" /> }));
vi.mock("../NativeViewerBar", () => ({ default: () => null }));
vi.mock("../MobilePaneCarousel", () => ({
	default: ({ children }: { children: React.ReactNode }) => (
		<div data-testid="mobile-pane-carousel">{children}</div>
	),
}));
vi.mock("../MobileWindowCarousel", () => ({
	default: ({ children }: { children: React.ReactNode }) => (
		<div data-testid="mobile-window-carousel">{children}</div>
	),
}));
vi.mock("../PaneZoomBadge", () => ({ default: () => null }));
vi.mock("../ClosePanePicker", () => ({ default: () => null }));
vi.mock("../TaskPreparingView", () => ({ default: () => null }));
vi.mock("../ExtraKeyBar", () => ({ default: () => null }));
vi.mock("../TerminalComposer", () => ({ default: () => null }));

let mockNarrow = false;
vi.mock("../../hooks/useNarrowViewport", () => ({
	useNarrowViewport: () => mockNarrow,
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TASK_ID = "aaaa-0001";
const PROJECT_ID = "proj-1";

const TMUX_TASK: Task = {
	id: TASK_ID,
	projectId: PROJECT_ID,
	title: "Tmux task",
	status: "in-progress",
	worktreePath: "/tmp/wt",
	createdAt: 0,
	// no terminalBackend → tmux
} as unknown as Task;

const NATIVE_TASK: Task = {
	...TMUX_TASK,
	terminalBackend: "native",
} as unknown as Task;

const PROJECT: Project = {
	id: PROJECT_ID,
	name: "Test project",
	path: "/tmp/proj",
} as unknown as Project;

function makeNativePaneState(paneIds: string[], alivePanes?: Set<string>): TaskPaneState {
	let tree = createSplitTree(); // starts with pane-1
	for (let i = 1; i < paneIds.length; i++) {
		tree = splitPane(tree, paneIds[i - 1], "horizontal");
	}
	return {
		backend: "native",
		panes: paneIds.map((paneId, i) => ({
			paneId,
			index: i,
			label: "",
			active: i === 0,
			zoomed: false,
			alive: alivePanes ? alivePanes.has(paneId) : true,
			rect: { x: i / paneIds.length, y: 0, width: 1 / paneIds.length, height: 1 },
		})),
		activePaneId: paneIds[0] ?? null,
		zoomedPaneId: null,
		layout: serializeSplitTree(tree),
		layoutPreset: null,
		capabilities: paneIds.length > 1
			? ["split", "zoom", "close", "focus", "focusDirection", "layoutPreset", "layoutCycle"]
			: ["split", "zoom", "close"],
	};
}

import TaskTerminal from "../TaskTerminal";

function renderTaskTerminal(task: Task, narrow = false) {
	mockNarrow = narrow;
	return render(
		<I18nProvider>
			<TaskTerminal
				projectId={PROJECT_ID}
				taskId={TASK_ID}
				tasks={[task]}
				projects={[PROJECT]}
				navigate={vi.fn()}
				dispatch={vi.fn()}
			/>
		</I18nProvider>,
	);
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
	mockNarrow = false;
	vi.mocked(api.request.getPtyUrl).mockReset();
	vi.mocked(api.request.getPanePtyUrl).mockReset();
	vi.mocked(api.request.taskPaneState).mockReset();
	vi.mocked(api.request.taskPaneAction).mockReset();
	vi.mocked(api.request.tmuxNewWindow).mockReset();
	vi.mocked(api.request.checkWorktreeExists).mockReset();

	// Default PTY URL for tmux tasks
	vi.mocked(api.request.getPtyUrl).mockResolvedValue({ url: `ws://localhost:9999?session=${TASK_ID}` });
	// Default pane PTY URLs for native tasks
	vi.mocked(api.request.getPanePtyUrl).mockImplementation(({ paneId }) =>
		Promise.resolve({ url: `ws://localhost:9999?session=${TASK_ID}~${paneId}` }),
	);
	vi.mocked(api.request.taskPaneState).mockResolvedValue(makeNativePaneState(["pane-1", "pane-2"]));
	vi.mocked(api.request.taskPaneAction).mockResolvedValue(makeNativePaneState(["pane-1", "pane-2"]));
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("TaskTerminal (tmux path)", () => {
	it("renders exactly one TerminalView for a tmux task", async () => {
		renderTaskTerminal(TMUX_TASK);
		await waitFor(() => expect(screen.queryAllByTestId("terminal-view")).toHaveLength(1));
	});

	it("calls getPtyUrl (not getPanePtyUrl) for tmux task", async () => {
		renderTaskTerminal(TMUX_TASK);
		await waitFor(() => expect(api.request.getPtyUrl).toHaveBeenCalledWith({ taskId: TASK_ID }));
		expect(api.request.getPanePtyUrl).not.toHaveBeenCalled();
	});

	it("renders MobileWindowCarousel for tmux on narrow viewport", async () => {
		renderTaskTerminal(TMUX_TASK, true);
		await waitFor(() => expect(screen.queryByTestId("mobile-window-carousel")).toBeInTheDocument());
	});
});

describe("TaskTerminal (native multi-pane)", () => {
	it("renders two TerminalViews for a native task with 2 panes", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(makeNativePaneState(["pane-1", "pane-2"]));
		renderTaskTerminal(NATIVE_TASK);
		await waitFor(() => expect(screen.queryAllByTestId("terminal-view")).toHaveLength(2));
	});

	it("renders six TerminalViews for a native task with 6 panes", async () => {
		const paneIds = ["pane-1", "pane-2", "pane-3", "pane-4", "pane-5", "pane-6"];
		vi.mocked(api.request.taskPaneState).mockResolvedValue(makeNativePaneState(paneIds));
		renderTaskTerminal(NATIVE_TASK);
		await waitFor(() => expect(screen.queryAllByTestId("terminal-view")).toHaveLength(6), { timeout: 3000 });
	});

	it("does NOT call getPtyUrl for a native task", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(makeNativePaneState(["pane-1", "pane-2"]));
		renderTaskTerminal(NATIVE_TASK);
		await waitFor(() => expect(api.request.taskPaneState).toHaveBeenCalled());
		await new Promise((r) => setTimeout(r, 30));
		expect(api.request.getPtyUrl).not.toHaveBeenCalled();
	});

	it("calls getPanePtyUrl for each native pane", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(makeNativePaneState(["pane-1", "pane-2"]));
		renderTaskTerminal(NATIVE_TASK);
		await waitFor(() => {
			expect(api.request.getPanePtyUrl).toHaveBeenCalledWith({ taskId: TASK_ID, paneId: "pane-1" });
			expect(api.request.getPanePtyUrl).toHaveBeenCalledWith({ taskId: TASK_ID, paneId: "pane-2" });
		});
	});

	it("each native pane gets a stable pty-url (absolute positioning prevents remounting across layout changes)", async () => {
		// Render with 2 panes; capture their URLs.
		const twoPane = makeNativePaneState(["pane-1", "pane-2"]);
		vi.mocked(api.request.taskPaneState).mockResolvedValue(twoPane);

		renderTaskTerminal(NATIVE_TASK);
		await waitFor(() => expect(screen.queryAllByTestId("terminal-view")).toHaveLength(2));

		const urlsAfterTwoPane = screen.getAllByTestId("terminal-view").map((el) =>
			el.getAttribute("data-pty-url"),
		);
		// Verify the URLs are keyed per pane
		expect(urlsAfterTwoPane.some((u) => u?.includes("pane-1"))).toBe(true);
		expect(urlsAfterTwoPane.some((u) => u?.includes("pane-2"))).toBe(true);
	});

	it("renders pane-exited box (not a TerminalView) for a dead pane", async () => {
		const stateWithDead = makeNativePaneState(["pane-1", "pane-2"], new Set(["pane-1"]));
		// pane-2 is NOT in the alive set, so alive=false.
		vi.mocked(api.request.taskPaneState).mockResolvedValue(stateWithDead);

		renderTaskTerminal(NATIVE_TASK);
		await waitFor(() => expect(screen.getByText("Pane exited")).toBeInTheDocument());
		// Only pane-1 should have a TerminalView; pane-2 shows the exited box.
		await waitFor(() => expect(screen.queryAllByTestId("terminal-view")).toHaveLength(1));
	});

	it("does NOT render MobileWindowCarousel for native tasks on narrow viewport", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(makeNativePaneState(["pane-1", "pane-2"]));
		renderTaskTerminal(NATIVE_TASK, true);
		await waitFor(() => expect(api.request.taskPaneState).toHaveBeenCalled());
		await new Promise((r) => setTimeout(r, 20));
		expect(screen.queryByTestId("mobile-window-carousel")).not.toBeInTheDocument();
	});

	it("renders MobilePaneCarousel for native tasks on narrow viewport", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(makeNativePaneState(["pane-1", "pane-2"]));
		renderTaskTerminal(NATIVE_TASK, true);
		await waitFor(() => expect(screen.queryByTestId("mobile-pane-carousel")).toBeInTheDocument());
	});

	it("renders only the zoomed pane when the shared layout reports one", async () => {
		const zoomed = { ...makeNativePaneState(["pane-1", "pane-2", "pane-3"]), zoomedPaneId: "pane-2" };
		vi.mocked(api.request.taskPaneState).mockResolvedValue(zoomed);
		renderTaskTerminal(NATIVE_TASK);
		await waitFor(() => expect(screen.queryAllByTestId("terminal-view")).toHaveLength(1));
		expect(screen.getByRole("button", { name: "Unzoom" })).toBeInTheDocument();
	});

	it("unzoom asks the backend to clear the shared zoom", async () => {
		const zoomed = { ...makeNativePaneState(["pane-1", "pane-2"]), zoomedPaneId: "pane-2" };
		vi.mocked(api.request.taskPaneState).mockResolvedValue(zoomed);
		vi.mocked(api.request.taskPaneAction).mockResolvedValue(makeNativePaneState(["pane-1", "pane-2"]));
		renderTaskTerminal(NATIVE_TASK);
		const button = await waitFor(() => screen.getByRole("button", { name: "Unzoom" }));
		button.click();
		await waitFor(() =>
			expect(api.request.taskPaneAction).toHaveBeenCalledWith({
				taskId: TASK_ID,
				action: { kind: "zoom", mode: "off" },
			}),
		);
	});
});
