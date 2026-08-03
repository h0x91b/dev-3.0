/**
 * Client-local native pane focus must not survive the pane it points at (seq 1407).
 *
 * Focus is client-local by design (decision 179), so the server never corrects it.
 * That makes pruning this viewer's job: when the focused pane leaves the pane set —
 * a dev-server pane closing is the common way — focus has to move to a pane that is
 * still there. A stale focus id silently breaks three things at once: no pane draws
 * the focus ring, `NativeViewerBar` keeps offering "take control" of a dead pane, and
 * the inspector toolbar (which reads the published focus) aims split/zoom/close at a
 * pane id the coordinator no longer knows.
 */

import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task, Project } from "../../../shared/types";
import type { TaskPaneState } from "../../../shared/task-panes";
import { createSplitTree, serializeSplitTree, splitPane } from "../../../shared/split-tree";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";
import { _resetPaneStateBus, fetchPaneState } from "../../pane-state-bus";
import { _resetNativePaneFocus, currentNativePaneFocus } from "../../native-pane-focus";

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

vi.mock("../../TerminalView", () => ({
	default: ({ ptyUrl }: { ptyUrl: string }) => <div data-testid="terminal-view" data-pty-url={ptyUrl} />,
}));
vi.mock("../TaskInfoPanel", () => ({ default: () => null }));
vi.mock("../NativeViewerBar", () => ({ default: () => <div data-testid="native-viewer-bar" /> }));
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

const TASK_ID = "task-focus-prune";
const PROJECT_ID = "proj-1";
const AGENT_PANE = "pane-1";
const DEV_PANE = "pane-2";

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
		capabilities: ["split", "zoom", "close", "focus"],
	};
}

import TaskTerminal from "../TaskTerminal";

let currentPanes: string[] = [AGENT_PANE];

beforeEach(() => {
	currentPanes = [AGENT_PANE];
	_resetPaneStateBus();
	_resetNativePaneFocus();
	for (const fn of Object.values(api.request)) vi.mocked(fn as (...a: unknown[]) => unknown).mockReset();
	vi.mocked(api.request.taskPaneState).mockImplementation(() => Promise.resolve(paneState(currentPanes)));
	vi.mocked(api.request.taskPaneAction).mockImplementation(() => Promise.resolve(paneState(currentPanes)));
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

async function deliverPanes(paneIds: string[]) {
	currentPanes = paneIds;
	await act(async () => {
		await fetchPaneState(TASK_ID);
	});
}

function focusedPaneIds(): string[] {
	return [...document.querySelectorAll('[data-pane-id][data-focused="true"]')].map(
		(el) => el.getAttribute("data-pane-id") ?? "",
	);
}

describe("native pane focus survives the pane leaving the set", () => {
	it("moves focus to a live pane when the focused dev-server pane closes", async () => {
		mountTerminal();
		await deliverPanes([AGENT_PANE, DEV_PANE]);
		await waitFor(() => expect(screen.queryAllByTestId("terminal-view")).toHaveLength(2));

		// The user clicks into the dev-server pane, so focus is client-local on it.
		const devPaneEl = document.querySelector(`[data-pane-id="${DEV_PANE}"]`)!;
		fireEvent.click(devPaneEl);
		await waitFor(() => expect(focusedPaneIds()).toEqual([DEV_PANE]));
		expect(currentNativePaneFocus(TASK_ID)).toBe(DEV_PANE);

		// Stop Dev Server: the coordinator closes the pane and the new set arrives.
		await deliverPanes([AGENT_PANE]);
		await waitFor(() => expect(screen.queryAllByTestId("terminal-view")).toHaveLength(1));

		// Focus must have followed the pane set, not stayed on the pane that is gone.
		expect(focusedPaneIds()).toEqual([AGENT_PANE]);
		expect(currentNativePaneFocus(TASK_ID)).toBe(AGENT_PANE);
	});

	it("does not keep the viewer bar bound to a pane that left the set", async () => {
		mountTerminal();
		await deliverPanes([AGENT_PANE, DEV_PANE]);
		await waitFor(() => expect(screen.queryAllByTestId("terminal-view")).toHaveLength(2));

		fireEvent.click(document.querySelector(`[data-pane-id="${DEV_PANE}"]`)!);
		await waitFor(() => expect(focusedPaneIds()).toEqual([DEV_PANE]));

		await deliverPanes([AGENT_PANE]);
		await waitFor(() => expect(screen.queryAllByTestId("terminal-view")).toHaveLength(1));

		// The bar may still render — but for the surviving pane, never the closed one.
		expect(focusedPaneIds()).not.toContain(DEV_PANE);
	});
});
