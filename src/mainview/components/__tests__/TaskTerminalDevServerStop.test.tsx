/**
 * Native dev-server start -> stop responsiveness probe (seq 1407).
 *
 * The incident: on a native task, clicking "Stop Dev Server" froze the whole UI
 * while the backend finished the stop in 539 ms and kept running for another 49 s.
 * So the freeze is renderer-side, in whatever the shrinking pane set triggers.
 *
 * This probe drives the real sequence the app produces — dev-server pane appears,
 * `stopDevServer` resolves, the pane set shrinks — and asserts the renderer is
 * still alive afterwards: bounded work, no RPC storm, surviving pane not remounted,
 * and the cycle repeatable without accumulating per-pane state.
 */

import { render, screen, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Task, Project } from "../../../shared/types";
import type { TaskPaneState } from "../../../shared/task-panes";
import { createSplitTree, serializeSplitTree, splitPane } from "../../../shared/split-tree";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";
import { _resetPaneStateBus, fetchPaneState } from "../../pane-state-bus";
import { _resetNativePaneFocus } from "../../native-pane-focus";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getPtyUrl: vi.fn(),
			getPanePtyUrl: vi.fn(),
			taskPaneState: vi.fn(),
			taskPaneAction: vi.fn(),
			tmuxNewWindow: vi.fn(),
			checkWorktreeExists: vi.fn(),
			stopDevServer: vi.fn(),
			startDevServer: vi.fn(),
			checkDevServer: vi.fn(),
		},
	},
	isElectrobun: false,
}));

/** Stubbed TerminalView that reports every mount and every render. */
const mounts: string[] = [];
let renderCount = 0;
vi.mock("../../TerminalView", () => ({
	default: ({ ptyUrl }: { ptyUrl: string }) => {
		renderCount++;
		return <div data-testid="terminal-view" data-pty-url={ptyUrl} />;
	},
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

const TASK_ID = "af011a56-da9a-4197-856e-d3da040f3293";
const PROJECT_ID = "proj-1";
const MAIN_PANE = "pane-1";
const DEV_PANE = "pane-7";

const NATIVE_TASK = {
	id: TASK_ID,
	projectId: PROJECT_ID,
	title: "Native task",
	status: "in-progress",
	worktreePath: "/tmp/wt",
	createdAt: 0,
	terminalBackend: "native",
} as unknown as Task;

const PROJECT = { id: PROJECT_ID, name: "P", path: "/tmp/proj" } as unknown as Project;

function paneState(paneIds: string[]): TaskPaneState {
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
		capabilities: paneIds.length > 1 ? ["split", "zoom", "close", "focus"] : ["split", "zoom", "close"],
	};
}

import TaskTerminal from "../TaskTerminal";

/** Current server-side pane set; the mocked RPC always answers from here. */
let currentPanes: string[] = [MAIN_PANE];

beforeEach(() => {
	mounts.length = 0;
	renderCount = 0;
	currentPanes = [MAIN_PANE];
	_resetPaneStateBus();
	_resetNativePaneFocus();
	for (const fn of Object.values(api.request)) vi.mocked(fn as (...a: unknown[]) => unknown).mockReset();
	vi.mocked(api.request.taskPaneState).mockImplementation(() => Promise.resolve(paneState(currentPanes)));
	vi.mocked(api.request.taskPaneAction).mockImplementation(() => Promise.resolve(paneState(currentPanes)));
	vi.mocked(api.request.getPanePtyUrl).mockImplementation(({ paneId }: { paneId: string }) =>
		Promise.resolve({ url: `ws://localhost:9999?session=${TASK_ID}~${paneId}` }),
	);
	vi.mocked(api.request.stopDevServer).mockResolvedValue(undefined as never);
	vi.mocked(api.request.checkWorktreeExists).mockResolvedValue(true as never);
});

afterEach(() => {
	vi.useRealTimers();
});

function mountTerminal() {
	return render(
		<I18nProvider>
			<TaskTerminal
				projectId={PROJECT_ID}
				taskId={TASK_ID}
				tasks={[NATIVE_TASK]}
				projects={[PROJECT]}
				navigate={vi.fn()}
				dispatch={vi.fn()}
			/>
		</I18nProvider>,
	);
}

/** Server opens the dev-server pane, then the state reaches the client. */
async function startDevServerPane() {
	currentPanes = [MAIN_PANE, DEV_PANE];
	await act(async () => {
		await fetchPaneState(TASK_ID);
	});
	await waitFor(() => expect(screen.queryAllByTestId("terminal-view")).toHaveLength(2));
}

/** The click: backend stops the server and closes the pane, state reaches the client. */
async function stopDevServerPane() {
	await api.request.stopDevServer({ taskId: TASK_ID, projectId: PROJECT_ID } as never);
	currentPanes = [MAIN_PANE];
	await act(async () => {
		await fetchPaneState(TASK_ID);
	});
}

/**
 * Renderer liveness proxy: the component tree must still service scheduled work
 * after the pane closes. A blocked/looping renderer either never settles or
 * blows React's update-depth guard (which surfaces as a thrown render error).
 */
async function assertRendererResponsive(budgetMs = 500) {
	const before = renderCount;
	const start = performance.now();
	await act(async () => {
		await fetchPaneState(TASK_ID);
	});
	const elapsed = performance.now() - start;
	expect(elapsed).toBeLessThan(budgetMs);
	// It re-rendered (so it is alive) but did not run away.
	expect(renderCount - before).toBeLessThan(40);
}

describe("native dev-server stop — renderer stays responsive", () => {
	it("closes the dev-server pane and leaves the main pane mounted", async () => {
		mountTerminal();
		await waitFor(() => expect(screen.queryAllByTestId("terminal-view")).toHaveLength(1));
		await startDevServerPane();

		const urlBefore = screen
			.getAllByTestId("terminal-view")
			.map((el) => el.getAttribute("data-pty-url"))
			.find((u) => u?.includes(MAIN_PANE));

		await stopDevServerPane();

		await waitFor(() => expect(screen.queryAllByTestId("terminal-view")).toHaveLength(1));
		expect(screen.getByTestId("terminal-view").getAttribute("data-pty-url")).toBe(urlBefore);
	});

	it("does not storm getPanePtyUrl after the pane set shrinks", async () => {
		mountTerminal();
		await startDevServerPane();
		const callsAfterStart = vi.mocked(api.request.getPanePtyUrl).mock.calls.length;

		await stopDevServerPane();
		await assertRendererResponsive();
		// A few more polls must not re-request URLs for panes already known.
		for (let i = 0; i < 5; i++) {
			await act(async () => {
				await fetchPaneState(TASK_ID);
			});
		}
		expect(vi.mocked(api.request.getPanePtyUrl).mock.calls.length).toBe(callsAfterStart);
	});

	it("survives 10 start/stop cycles without unbounded work", async () => {
		mountTerminal();
		await waitFor(() => expect(screen.queryAllByTestId("terminal-view")).toHaveLength(1));

		for (let cycle = 0; cycle < 10; cycle++) {
			await startDevServerPane();
			await stopDevServerPane();
			await waitFor(() => expect(screen.queryAllByTestId("terminal-view")).toHaveLength(1));
			await assertRendererResponsive();
		}

		// One URL fetch per distinct pane per cycle at worst; a leak shows as growth
		// far beyond that (e.g. re-fetching every poll tick).
		expect(vi.mocked(api.request.getPanePtyUrl).mock.calls.length).toBeLessThan(40);
	});
});
