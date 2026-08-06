/**
 * "+ Agent" must leave the keyboard in the pane it just opened: the user's next
 * keystroke is the new agent's prompt, with no click in between.
 *
 * Two halves are asserted here — the viewer FOLLOWS a pane that is both brand new
 * and the server's active one, and it hands DOM focus to that pane's canvas once
 * it attaches (the pane does not exist yet when the dialog asks).
 */

import { useEffect } from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task, Project } from "../../../shared/types";
import type { TaskPaneState } from "../../../shared/task-panes";
import { createSplitTree, serializeSplitTree, splitPane } from "../../../shared/split-tree";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";
import { _resetPaneStateBus, fetchPaneState } from "../../pane-state-bus";
import { _resetNativePaneFocus } from "../../native-pane-focus";
import { requestTaskTerminalFocus } from "../../terminal-focus-request";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getPtyUrl: vi.fn(),
			getPanePtyUrl: vi.fn(),
			taskPaneState: vi.fn(),
			taskPaneAction: vi.fn(),
			checkWorktreeExists: vi.fn(),
		},
	},
	isElectrobun: false,
}));

/** Records a focus() spy per pane, keyed by the pane id embedded in its PTY URL. */
const focusCalls: string[] = [];

// onReady must fire ONCE per mount, from an effect: the real TerminalView reports
// its handle after the canvas attaches, and calling it during render would loop.
vi.mock("../../TerminalView", () => ({
	default: ({ ptyUrl, onReady }: { ptyUrl: string; onReady?: (h: unknown) => void }) => {
		const paneId = ptyUrl.split("~")[1] ?? "";
		useEffect(() => {
			onReady?.({ focus: () => focusCalls.push(paneId), blur: () => {}, paste: () => {}, claimWriter: () => {} });
		}, [ptyUrl]);
		return <div data-testid="terminal-view" data-pty-url={ptyUrl} />;
	},
}));
vi.mock("../TaskInfoPanel", () => ({ default: () => null }));
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

const TASK_ID = "task-spawn-focus";
const PROJECT_ID = "proj-1";
const AGENT_PANE = "pane-1";
const SPAWNED_PANE = "pane-2";

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

function paneState(paneIds: string[], activePaneId: string): TaskPaneState {
	let tree = createSplitTree();
	for (let i = 1; i < paneIds.length; i++) tree = splitPane(tree, paneIds[i - 1], "horizontal");
	return {
		backend: "native",
		panes: paneIds.map((paneId, i) => ({
			paneId,
			index: i,
			label: "",
			active: paneId === activePaneId,
			zoomed: false,
			alive: true,
			rect: { x: i / paneIds.length, y: 0, width: 1 / paneIds.length, height: 1 },
		})),
		activePaneId,
		zoomedPaneId: null,
		layout: serializeSplitTree(tree),
		layoutPreset: null,
		capabilities: ["split", "zoom", "close", "focus"],
	};
}

import TaskTerminal from "../TaskTerminal";

let currentPanes: string[] = [AGENT_PANE];
let currentActive = AGENT_PANE;

beforeEach(() => {
	currentPanes = [AGENT_PANE];
	currentActive = AGENT_PANE;
	focusCalls.length = 0;
	_resetPaneStateBus();
	_resetNativePaneFocus();
	for (const fn of Object.values(api.request)) vi.mocked(fn as (...a: unknown[]) => unknown).mockReset();
	vi.mocked(api.request.taskPaneState).mockImplementation(() => Promise.resolve(paneState(currentPanes, currentActive)));
	vi.mocked(api.request.taskPaneAction).mockImplementation(() => Promise.resolve(paneState(currentPanes, currentActive)));
	vi.mocked(api.request.getPanePtyUrl).mockImplementation(({ paneId }: { paneId: string }) =>
		Promise.resolve({ url: `ws://localhost:9999?session=${TASK_ID}~${paneId}` }),
	);
	vi.mocked(api.request.checkWorktreeExists).mockResolvedValue(true as never);
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

async function deliverPanes(paneIds: string[], activePaneId: string) {
	currentPanes = paneIds;
	currentActive = activePaneId;
	await act(async () => {
		await fetchPaneState(TASK_ID);
	});
}

function focusedPaneIds(): string[] {
	return [...document.querySelectorAll('[data-pane-id][data-focused="true"]')].map(
		(el) => el.getAttribute("data-pane-id") ?? "",
	);
}

describe("focus after spawning an agent into a native task", () => {
	it("follows a pane that is both new and the server's active one", async () => {
		mountTerminal();
		await deliverPanes([AGENT_PANE], AGENT_PANE);
		await waitFor(() => expect(screen.queryAllByTestId("terminal-view")).toHaveLength(1));

		await deliverPanes([AGENT_PANE, SPAWNED_PANE], SPAWNED_PANE);

		await waitFor(() => expect(focusedPaneIds()).toEqual([SPAWNED_PANE]));
	});

	it("gives the keyboard to the spawned pane once it attaches", async () => {
		mountTerminal();
		await deliverPanes([AGENT_PANE], AGENT_PANE);
		await waitFor(() => expect(screen.queryAllByTestId("terminal-view")).toHaveLength(1));
		focusCalls.length = 0;

		// The dialog asks BEFORE the pane exists — this is the whole ordering problem.
		await act(async () => { requestTaskTerminalFocus(TASK_ID); });
		await deliverPanes([AGENT_PANE, SPAWNED_PANE], SPAWNED_PANE);

		await waitFor(() => expect(focusCalls).toContain(SPAWNED_PANE));
		expect(focusCalls).not.toContain(AGENT_PANE);
	});

	it("leaves focus alone for an auxiliary pane that hands focus back", async () => {
		mountTerminal();
		await deliverPanes([AGENT_PANE], AGENT_PANE);
		await waitFor(() => expect(screen.queryAllByTestId("terminal-view")).toHaveLength(1));

		// A dev-server pane: new, but the coordinator kept the agent pane active.
		await deliverPanes([AGENT_PANE, SPAWNED_PANE], AGENT_PANE);
		await waitFor(() => expect(screen.queryAllByTestId("terminal-view")).toHaveLength(2));

		expect(focusedPaneIds()).toEqual([AGENT_PANE]);
	});

	it("never serves the request with the pane the user is already in", async () => {
		mountTerminal();
		await deliverPanes([AGENT_PANE], AGENT_PANE);
		await waitFor(() => expect(screen.queryAllByTestId("terminal-view")).toHaveLength(1));
		focusCalls.length = 0;

		// The spawn failed to produce a pane. Grabbing focus for the pane already on
		// screen would type the new agent's prompt into the OLD agent.
		await act(async () => { requestTaskTerminalFocus(TASK_ID); });
		await deliverPanes([AGENT_PANE], AGENT_PANE);

		expect(focusCalls).toEqual([]);
	});
});

describe("focus after spawning an agent into a tmux task", () => {
	const TMUX_TASK = { ...NATIVE_TASK, id: TASK_ID, terminalBackend: "tmux" } as unknown as Task;

	it("focuses the one canvas straight away — tmux itself activated the new pane", async () => {
		vi.mocked(api.request.getPtyUrl).mockResolvedValue({ url: `ws://localhost:9999?session=${TASK_ID}~tmux` } as never);
		render(
			<I18nProvider>
				<TaskTerminal
					projectId={PROJECT_ID}
					taskId={TASK_ID}
					tasks={[TMUX_TASK]}
					projects={[PROJECT]}
					navigate={vi.fn()}
					dispatch={vi.fn()}
				/>
			</I18nProvider>,
		);
		await waitFor(() => expect(screen.queryAllByTestId("terminal-view")).toHaveLength(1));
		focusCalls.length = 0;

		await act(async () => { requestTaskTerminalFocus(TASK_ID); });

		await waitFor(() => expect(focusCalls).toEqual(["tmux"]));
	});
});
