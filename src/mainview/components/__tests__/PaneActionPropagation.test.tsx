/**
 * A pane action repaints the canvas without waiting for a poll tick (seq 1382).
 *
 * The regression this guards: the inspector toolbar and the terminal canvas used to
 * hold separate copies of TaskPaneState, so a Split or Layout click updated the
 * toolbar and the canvas only caught up on its own 2500 ms poll — the backend work
 * took tens of milliseconds, the user waited seconds.
 *
 * Every case here runs with fake timers and NEVER advances them past the initial
 * mount fetch: anything that arrives is arriving through the action's own response.
 */

import { render, screen, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Task, Project } from "../../../shared/types";
import type { TaskPaneState } from "../../../shared/task-panes";
import { createSplitTree, serializeSplitTree, splitPane } from "../../../shared/split-tree";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";
import { _resetPaneStateBus, runPaneAction } from "../../pane-state-bus";

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

vi.mock("../../TerminalView", () => ({
	default: ({ ptyUrl }: { ptyUrl: string }) => <div data-testid="terminal-view" data-pty-url={ptyUrl} />,
}));
vi.mock("../TaskInfoPanel", () => ({ default: () => <div data-testid="task-info-panel" /> }));
vi.mock("../NativeViewerBar", () => ({ default: () => null }));
vi.mock("../MobilePaneCarousel", () => ({
	default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../MobileWindowCarousel", () => ({
	default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../PaneZoomBadge", () => ({ default: () => null }));
vi.mock("../ClosePanePicker", () => ({ default: () => null }));
vi.mock("../TaskPreparingView", () => ({ default: () => null }));
vi.mock("../ExtraKeyBar", () => ({ default: () => null }));
vi.mock("../TerminalComposer", () => ({ default: () => null }));
vi.mock("../../hooks/useNarrowViewport", () => ({ useNarrowViewport: () => false }));

const TASK_ID = "aaaa-0001";
const PROJECT_ID = "proj-1";

const TMUX_TASK = {
	id: TASK_ID,
	projectId: PROJECT_ID,
	title: "Task",
	status: "in-progress",
	worktreePath: "/tmp/wt",
	createdAt: 0,
} as unknown as Task;
const NATIVE_TASK = { ...TMUX_TASK, terminalBackend: "native" } as unknown as Task;
const PROJECT = { id: PROJECT_ID, name: "P", path: "/tmp/proj" } as unknown as Project;

function makeNativePaneState(paneIds: string[]): TaskPaneState {
	let tree = createSplitTree();
	for (let i = 1; i < paneIds.length; i++) tree = splitPane(tree, paneIds[i - 1], "horizontal");
	return {
		backend: "native",
		panes: paneIds.map((paneId, i) => ({
			paneId,
			index: i,
			label: "",
			active: i === 0,
			zoomed: false,
			alive: true,
			rect: { x: i / paneIds.length, y: 0, width: 1 / paneIds.length, height: 1 },
		})),
		activePaneId: paneIds[0] ?? null,
		zoomedPaneId: null,
		layout: serializeSplitTree(tree),
		layoutPreset: null,
		capabilities: paneIds.length > 1
			? ["split", "zoom", "close", "focus", "layoutPreset", "layoutCycle"]
			: ["split", "zoom", "close"],
	};
}

import TaskTerminal from "../TaskTerminal";

function renderTerminal(task: Task) {
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

beforeEach(() => {
	_resetPaneStateBus();
	vi.useFakeTimers({ shouldAdvanceTime: true });
	vi.mocked(api.request.getPtyUrl).mockReset().mockResolvedValue({ url: `ws://x?session=${TASK_ID}` });
	vi.mocked(api.request.getPanePtyUrl).mockReset().mockImplementation(({ paneId }) =>
		Promise.resolve({ url: `ws://x?session=${TASK_ID}~${paneId}` }),
	);
	vi.mocked(api.request.taskPaneState).mockReset().mockResolvedValue(makeNativePaneState(["pane-1", "pane-2"]));
	vi.mocked(api.request.taskPaneAction).mockReset();
	vi.mocked(api.request.checkWorktreeExists).mockReset().mockResolvedValue(true);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("pane action propagation (native)", () => {
	it("renders a split's new pane from the action's own response, with no poll tick", async () => {
		renderTerminal(NATIVE_TASK);
		await waitFor(() => expect(screen.queryAllByTestId("terminal-view")).toHaveLength(2));
		const pollsAtStart = vi.mocked(api.request.taskPaneState).mock.calls.length;

		vi.mocked(api.request.taskPaneAction).mockResolvedValue(
			makeNativePaneState(["pane-1", "pane-2", "pane-3"]),
		);
		await act(async () => {
			await runPaneAction(TASK_ID, { kind: "splitH", paneId: "pane-1" });
		});

		await waitFor(() => expect(screen.queryAllByTestId("terminal-view")).toHaveLength(3));
		expect(vi.mocked(api.request.taskPaneState).mock.calls.length).toBe(pollsAtStart);
	});

	it("repaints geometry from a layout preset response, with no poll tick", async () => {
		renderTerminal(NATIVE_TASK);
		await waitFor(() => expect(screen.queryAllByTestId("terminal-view")).toHaveLength(2));
		// The boundary between the two panes is the geometry witness: side-by-side
		// panes get a vertical divider, stacked panes a horizontal one.
		expect(screen.getByTestId("pane-divider-split-1").className).toContain("cursor-col-resize");
		const pollsAtStart = vi.mocked(api.request.taskPaneState).mock.calls.length;

		// Same pane set, vertical stack: each pane now spans the full width.
		let stacked = createSplitTree();
		stacked = splitPane(stacked, "pane-1", "vertical");
		const state = makeNativePaneState(["pane-1", "pane-2"]);
		vi.mocked(api.request.taskPaneAction).mockResolvedValue({
			...state,
			layout: serializeSplitTree(stacked),
		});
		await act(async () => {
			await runPaneAction(TASK_ID, { kind: "layoutPreset", preset: "evenV" });
		});

		await waitFor(() =>
			expect(screen.getByTestId("pane-divider-split-1").className).toContain("cursor-row-resize"),
		);
		expect(vi.mocked(api.request.taskPaneState).mock.calls.length).toBe(pollsAtStart);
	});

	it("drops a stale poll response that resolves after an action", async () => {
		renderTerminal(NATIVE_TASK);
		await waitFor(() => expect(screen.queryAllByTestId("terminal-view")).toHaveLength(2));

		let releasePoll!: (state: TaskPaneState) => void;
		vi.mocked(api.request.taskPaneState).mockReturnValue(
			new Promise<TaskPaneState>((resolve) => { releasePoll = resolve; }),
		);
		vi.mocked(api.request.taskPaneAction).mockResolvedValue(
			makeNativePaneState(["pane-1", "pane-2", "pane-3"]),
		);

		await act(async () => {
			vi.advanceTimersByTime(2500);           // poll issued, left hanging
			await runPaneAction(TASK_ID, { kind: "splitH" });
			releasePoll(makeNativePaneState(["pane-1", "pane-2"])); // pre-split view
			await Promise.resolve();
		});

		await waitFor(() => expect(screen.queryAllByTestId("terminal-view")).toHaveLength(3));
		expect(screen.queryAllByTestId("terminal-view")).toHaveLength(3);
	});
});

describe("pane action propagation (tmux is untouched)", () => {
	it("keeps a tmux task on its single TerminalView when a pane state is broadcast", async () => {
		renderTerminal(TMUX_TASK);
		await waitFor(() => expect(screen.queryAllByTestId("terminal-view")).toHaveLength(1));

		vi.mocked(api.request.taskPaneAction).mockResolvedValue(
			makeNativePaneState(["pane-1", "pane-2", "pane-3"]),
		);
		await act(async () => {
			await runPaneAction(TASK_ID, { kind: "splitH" });
		});

		expect(screen.queryAllByTestId("terminal-view")).toHaveLength(1);
		expect(api.request.getPanePtyUrl).not.toHaveBeenCalled();
	});

	it("never polls native pane state for a tmux task", async () => {
		renderTerminal(TMUX_TASK);
		await waitFor(() => expect(api.request.getPtyUrl).toHaveBeenCalled());
		await act(async () => { vi.advanceTimersByTime(10_000); });
		expect(api.request.taskPaneState).not.toHaveBeenCalled();
	});
});
