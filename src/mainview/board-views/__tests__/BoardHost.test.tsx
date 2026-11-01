import { StrictMode, memo, type Dispatch } from "react";
import type { AppAction } from "../../state";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Context } from "cordis";
import type { Project, Space, Task } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";
import { setHiddenControlsForTests } from "../../hidden-controls";
import BoardHost from "../BoardHost";
import { getBoardRoot, getBoardViewRegistry, resetBoardRootForTests, startBoardViews } from "../root";
import { installKanbanView } from "../kanban";
import { useBoard } from "../react";
import { resetBoardViewStateCacheForTests } from "../useBoardViewState";
import { defaultBoardViewState, withViewType } from "../../../shared/board-view-state";
import { _resetTaskLineageStoreForTest } from "../../hooks/useTaskLineage";
import { setStreamerMode } from "../../streamer-mode";
import { isBoardMounted, resetBoardViewCommandsForTests, runBoardViewCommand } from "../view-commands";
import { resetPreviousBoardViewsForTests } from "../BoardHost";
import { toast } from "../../toast";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getAgents: vi.fn().mockResolvedValue([]),
			getProjectPRs: vi.fn().mockResolvedValue([]),
			getTaskLineage: vi.fn().mockResolvedValue({ nodes: [] }),
			getBoardViewState: vi.fn(),
			setBoardViewState: vi.fn(async ({ state }) => state),
			createLabel: vi.fn(),
			getGlobalSettings: vi.fn().mockResolvedValue({ taskSortOrder: "oldest-first" }),
			moveTaskToCustomColumn: vi.fn(),
			createCustomColumn: vi.fn(),
			reorderColumns: vi.fn().mockResolvedValue(undefined),
		},
	},
}));

// Kanban is covered by its own suites (rendered through this host); here it
// only has to prove which tasks `ctx.board` handed it.
vi.mock("../kanban/KanbanView", async () => {
	const { useBoard } = await import("../react");
	return {
		KanbanView: () => {
			const board = useBoard();
			return <div data-testid="kanban" data-total={board.scopeTasks().length} data-shown={board.tasks().map((t) => t.id).join(",")} />;
		},
	};
});

const project: Project = {
	id: "p1",
	name: "Test Project",
	path: "/tmp/test",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
};

function makeTask(id: string, title: string, overrides: Partial<Task> = {}): Task {
	return {
		id, seq: Number(id.replace(/\D/g, "")) || 1, projectId: "p1", title, description: title, status: "todo",
		baseBranch: "main", worktreePath: null, branchName: null, groupId: null, variantIndex: null,
		agentId: null, configId: null, createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z",
		customColumnId: null, labelIds: [], notes: [], history: [], ...overrides,
	};
}

const tasks = [makeTask("t1", "alpha"), makeTask("t2", "beta", { status: "completed" })];

function renderHost(props: { tasks?: Task[]; strict?: boolean; dispatch?: Dispatch<AppAction>; project?: Project; space?: Space; allProjects?: Project[] } = {}) {
	const tree = (list: Task[]) => (
		<I18nProvider>
			<BoardHost
				project={props.project ?? project}
				space={props.space}
				memberProjects={props.space ? [props.project ?? project] : undefined}
				allProjects={props.allProjects}
				tasks={list}
				dispatch={props.dispatch ?? vi.fn()}
				navigate={vi.fn()}
				bellCounts={new Map()}
				taskPorts={new Map()}
				taskDevServers={new Map()}
			/>
		</I18nProvider>
	);
	const wrap = (list: Task[]) => (props.strict ? <StrictMode>{tree(list)}</StrictMode> : tree(list));
	const result = render(wrap(props.tasks ?? tasks));
	return { ...result, rerenderWith: (list: Task[]) => result.rerender(wrap(list)) };
}

function registerView(id: string, opts: { supportsNarrow?: boolean; component?: React.ComponentType<{ ctx: Context }> } = {}) {
	getBoardRoot().plugin({
		name: id,
		inject: ["board", "boardViews"],
		apply(ctx: Context) {
			ctx.boardViews.register({
				id,
				label: id,
				component: opts.component ?? (() => <div data-testid={`view-${id}`} />),
				supportsNarrow: opts.supportsNarrow ?? true,
			});
		},
	});
}

beforeEach(() => {
	resetBoardRootForTests();
	resetBoardViewStateCacheForTests();
	resetBoardViewCommandsForTests();
	resetPreviousBoardViewsForTests();
	setHiddenControlsForTests([]);
	vi.mocked(api.request.getBoardViewState).mockResolvedValue(defaultBoardViewState());
	vi.mocked(api.request.setBoardViewState).mockClear();
	localStorage.clear();
});

describe("BoardHost", () => {
	it("renders Kanban and provides ctx.board under StrictMode", async () => {
		startBoardViews([installKanbanView]);
		renderHost({ strict: true });
		expect(screen.getByTestId("kanban")).toHaveAttribute("data-total", "2");
		await waitFor(() => expect(getBoardViewRegistry().list().map((v) => v.def.id)).toEqual(["builtin:kanban"]));
		expect(getBoardRoot().board.scope).toEqual({ kind: "project", id: "p1", projectIds: ["p1"] });
		expect(getBoardRoot().board.tasks().map((t) => t.id)).toEqual(["t1", "t2"]);
	});

	it("renders Kanban on the first frame, before any plugin has registered", () => {
		renderHost();
		expect(screen.getByTestId("kanban")).toBeInTheDocument();
	});

	it("filters through the shared row: views get scope ∩ query, all statuses", async () => {
		renderHost();
		fireEvent.change(screen.getByRole("textbox", { name: /search/i }), { target: { value: "beta" } });
		expect(screen.getByTestId("kanban")).toHaveAttribute("data-shown", "t2");
		expect(screen.getByTestId("kanban")).toHaveAttribute("data-total", "2");
		expect(getBoardRoot().board.query).toBe("beta");
		expect(getBoardRoot().board.matches(tasks[0], "alpha")).toBe(true);
	});

	it("re-renders a memoised view on board/changed", async () => {
		startBoardViews([installKanbanView]);
		const Count = memo(function Count() {
			const board = useBoard();
			return <div data-testid="count">{board.tasks().length}</div>;
		});
		registerView("ext:count", { component: Count });
		vi.mocked(api.request.getBoardViewState).mockResolvedValue(withViewType(defaultBoardViewState(), "wide", "ext:count"));
		const { rerenderWith } = renderHost();
		expect(await screen.findByTestId("count")).toHaveTextContent("2");
		act(() => rerenderWith([...tasks, makeTask("t3", "gamma")]));
		await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("3"));
	});

	it("hides the switcher while only one view is enabled", async () => {
		startBoardViews([installKanbanView]);
		renderHost();
		await waitFor(() => expect(getBoardViewRegistry().list()).toHaveLength(1));
		expect(screen.queryByTestId("board-view-switcher")).not.toBeInTheDocument();
		expect(screen.queryByTestId("board-view-options")).not.toBeInTheDocument();
	});

	it("shows the switcher for two views and saves the pick without navigating", async () => {
		startBoardViews([installKanbanView]);
		registerView("ext:list");
		renderHost();
		const switcher = await screen.findByTestId("board-view-switcher");
		fireEvent.click(switcher.querySelector("button")!);
		fireEvent.click(await screen.findByRole("option", { name: "ext:list" }));
		expect(await screen.findByTestId("view-ext:list")).toBeInTheDocument();
		await waitFor(() => expect(api.request.setBoardViewState).toHaveBeenCalledTimes(1));
		const saved = vi.mocked(api.request.setBoardViewState).mock.calls[0][0];
		expect(saved.board).toEqual({ kind: "project", id: "p1" });
		expect(saved.state.savedViews.find((v) => v.id === saved.state.slots.wide)?.viewType).toBe("ext:list");
	});

	it("hides the switcher in Simplify mode", async () => {
		setHiddenControlsForTests([]);
		const { syncHiddenControlsFromGlobalSettings } = await import("../../hidden-controls");
		syncHiddenControlsFromGlobalSettings({ simplifiedMode: true });
		startBoardViews([installKanbanView]);
		registerView("ext:list");
		renderHost();
		await waitFor(() => expect(getBoardViewRegistry().list()).toHaveLength(2));
		expect(screen.queryByTestId("board-view-switcher")).not.toBeInTheDocument();
		syncHiddenControlsFromGlobalSettings({ simplifiedMode: false });
	});

	it("falls back to Kanban when a view crashes, keeping the saved choice", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		startBoardViews([installKanbanView]);
		registerView("ext:boom", { component: () => { throw new Error("boom"); } });
		vi.mocked(api.request.getBoardViewState).mockResolvedValue(withViewType(defaultBoardViewState(), "wide", "ext:boom"));
		renderHost();
		expect(await screen.findByRole("alert")).toBeInTheDocument();
		expect(screen.getByTestId("kanban")).toBeInTheDocument();
		expect(api.request.setBoardViewState).not.toHaveBeenCalled();
	});

	it("withdraws ctx.board on unmount, which stops plugins that inject it", async () => {
		startBoardViews([installKanbanView]);
		const { unmount } = renderHost();
		await waitFor(() => expect(getBoardViewRegistry().list()).toHaveLength(1));
		unmount();
		await waitFor(() => expect(getBoardViewRegistry().list()).toHaveLength(0));
		expect(getBoardRoot().get("board")).toBeUndefined();
	});

	it("creates a label project-wide and hands it back; a failure rejects", async () => {
		const dispatch = vi.fn();
		renderHost({ dispatch });
		const label = { id: "l1", name: "Ops", color: "#fff" };
		vi.mocked(api.request.createLabel).mockResolvedValueOnce(label);
		await expect(getBoardRoot().board.createLabel("p1", "Ops")).resolves.toEqual(label);
		expect(api.request.createLabel).toHaveBeenCalledWith({ projectId: "p1", name: "Ops" });
		expect(dispatch).toHaveBeenCalledWith({ type: "updateProject", project: { ...project, labels: [label] } });

		vi.mocked(api.request.createLabel).mockRejectedValueOnce(new Error("nope"));
		await expect(getBoardRoot().board.createLabel("p1", "Ops")).rejects.toThrow("nope");
		await expect(getBoardRoot().board.createLabel("elsewhere", "Ops")).rejects.toThrow(/not on this board/);
	});
	it("lists the config's lanes by default and adds occupied hidden built-ins on request", () => {
		const ops: Project = { ...project, kind: "virtual" };
		renderHost({ project: ops, tasks: [makeTask("t1", "alpha", { status: "review-by-ai" })] });
		const statuses = (opts?: { includeOccupied?: boolean }) =>
			getBoardRoot().board.columns(opts).flatMap((slot) => (slot.type === "builtin" ? [slot.status] : []));
		expect(statuses()).not.toContain("review-by-ai");
		expect(statuses({ includeOccupied: true })).toContain("review-by-ai");
	});

	it("resolves lineage nodes off the board: null while loading, then the node or 'deleted'", async () => {
		_resetTaskLineageStoreForTest();
		let resolveIndex: ((index: unknown) => void) | undefined;
		vi.mocked(api.request.getTaskLineage).mockImplementationOnce(() => new Promise((resolve) => { resolveIndex = resolve; }) as never);
		const secret = { ...project, id: "p9", name: "Secret", sensitive: true };
		const parent = { id: "x1", projectId: "p9", projectName: "Secret", seq: 77, variantIndex: null, status: "in-progress", title: "Hidden plan" };
		renderHost({ allProjects: [project, secret] });
		expect(getBoardRoot().board.lineageNode("x1")).toBeNull();
		await waitFor(() => expect(resolveIndex).toBeTypeOf("function"));
		expect(getBoardRoot().board.lineageNode("x1")).toBeNull();
		await act(async () => {
			resolveIndex!({ nodes: [parent], edges: [] });
		});
		await waitFor(() => expect(getBoardRoot().board.lineageNode("x1")).toMatchObject({ seq: 77, title: "Hidden plan" }));
		expect(getBoardRoot().board.lineageNode("gone")).toBe("deleted");
		act(() => setStreamerMode(true));
		try {
			expect(getBoardRoot().board.lineageNode("x1")).toMatchObject({ seq: 77, projectName: "Secret", title: null });
		} finally {
			act(() => setStreamerMode(false));
		}
	});

	it("hands views the real task card through ctx.board.TaskCard", async () => {
		function Cards() {
			const board = useBoard();
			const Card = board.TaskCard;
			return <>{board.tasks().map((task) => <Card key={task.id} task={task} />)}</>;
		}
		registerView("ext:cards", { component: Cards });
		vi.mocked(api.request.getBoardViewState).mockResolvedValue(withViewType(defaultBoardViewState(), "wide", "ext:cards"));
		renderHost();
		expect(await screen.findByText("alpha")).toBeInTheDocument();
	});

	it("moves to a custom column optimistically, reporting progress, and reverts on failure", async () => {
		const dispatch = vi.fn();
		renderHost({ dispatch });
		const moving = vi.fn();
		vi.mocked(api.request.moveTaskToCustomColumn).mockRejectedValueOnce(new Error("nope"));
		await act(() => getBoardRoot().board.moveTask("t1", { customColumnId: "col-a" }, { onMovingChange: moving }));
		expect(dispatch).toHaveBeenNthCalledWith(1, { type: "updateTask", task: { ...tasks[0], customColumnId: "col-a" } });
		expect(dispatch).toHaveBeenLastCalledWith({ type: "updateTask", task: tasks[0] });
		expect(moving.mock.calls).toEqual([[true], [false]]);
	});

	it("reorders a project board's columns and refuses column edits on a space board", async () => {
		const dispatch = vi.fn();
		const { unmount } = renderHost({ dispatch });
		await act(() => getBoardRoot().board.reorderColumns(["completed", "todo"]));
		expect(api.request.reorderColumns).toHaveBeenCalledWith({ projectId: "p1", columnOrder: ["completed", "todo"] });
		expect(dispatch).toHaveBeenCalledWith({ type: "updateProject", project: { ...project, customColumns: [], columnOrder: ["completed", "todo"] } });
		unmount();

		const space = { id: "s1", name: "Space", projectIds: ["p1"] } as unknown as Space;
		renderHost({ space });
		await expect(getBoardRoot().board.reorderColumns(["todo"])).rejects.toThrow(/space board/);
		await expect(getBoardRoot().board.createColumn()).rejects.toThrow(/space board/);
	});

	it("follows the settings push for the sort order", async () => {
		renderHost();
		await waitFor(() => expect(getBoardRoot().board.preferences().taskSortOrder).toBe("oldest-first"));
		act(() => {
			window.dispatchEvent(new CustomEvent("rpc:globalSettingsUpdated", { detail: { taskSortOrder: "newest-first", tipsDisabled: true } }));
		});
		expect(getBoardRoot().board.preferences()).toEqual({ taskSortOrder: "newest-first", tipsDisabled: true });
	});
	it("creates a column once even when the project push lands before the RPC returns", async () => {
		const dispatch = vi.fn();
		const column = { id: "col-new", name: "New Column", color: "#f00", llmInstruction: "" };
		const pushed: Project = { ...project, customColumns: [column], columnOrder: ["todo", "col-new", "completed"] };
		const host = (p: Project) => (
			<I18nProvider>
				<BoardHost project={p} tasks={tasks} dispatch={dispatch} navigate={vi.fn()} bellCounts={new Map()} taskPorts={new Map()} taskDevServers={new Map()} />
			</I18nProvider>
		);
		const { rerender } = render(host(project));
		vi.mocked(api.request.createCustomColumn).mockImplementationOnce(async () => {
			act(() => rerender(host(pushed)));
			return column;
		});
		await expect(getBoardRoot().board.createColumn()).resolves.toBe("col-new");
		const reorders = vi.mocked(api.request.reorderColumns).mock.calls;
		const order: string[] = reorders[reorders.length - 1][0].columnOrder;
		expect(order.filter((id) => id === "col-new")).toHaveLength(1);
		expect(order.indexOf("col-new")).toBe(order.indexOf("completed") - 1);
		const update = dispatch.mock.calls[dispatch.mock.calls.length - 1][0] as { project: Project };
		expect(update.project.customColumns).toEqual([column]);
	});
	describe("board-view commands (v chord, menu, palette)", () => {
		it("answers commands only while mounted", async () => {
			startBoardViews([installKanbanView]);
			const { unmount } = renderHost();
			expect(isBoardMounted()).toBe(true);
			unmount();
			expect(isBoardMounted()).toBe(false);
		});

		it("v N picks the Nth offered view; out of range does nothing", async () => {
			startBoardViews([installKanbanView]);
			registerView("ext:a");
			registerView("ext:b");
			renderHost();
			await screen.findByTestId("board-view-switcher");
			act(() => runBoardViewCommand({ kind: "nth", n: 3 }));
			expect(await screen.findByTestId("view-ext:b")).toBeInTheDocument();
			act(() => runBoardViewCommand({ kind: "nth", n: 9 }));
			expect(screen.getByTestId("view-ext:b")).toBeInTheDocument();
		});

		it("v v toggles back to the previous view, and again", async () => {
			startBoardViews([installKanbanView]);
			registerView("ext:a");
			renderHost();
			await screen.findByTestId("board-view-switcher");
			act(() => runBoardViewCommand({ kind: "previous" }));
			expect(screen.getByTestId("kanban")).toBeInTheDocument();
			act(() => runBoardViewCommand({ kind: "nth", n: 2 }));
			expect(await screen.findByTestId("view-ext:a")).toBeInTheDocument();
			act(() => runBoardViewCommand({ kind: "previous" }));
			expect(await screen.findByTestId("kanban")).toBeInTheDocument();
			act(() => runBoardViewCommand({ kind: "previous" }));
			expect(await screen.findByTestId("view-ext:a")).toBeInTheDocument();
		});

		it("picks a view by id and says so when the board does not offer it", async () => {
			const info = vi.spyOn(toast, "info").mockImplementation(() => "");
			startBoardViews([installKanbanView]);
			registerView("ext:a");
			registerView("ext:wide-only", { supportsNarrow: false });
			renderHost();
			await screen.findByTestId("board-view-switcher");
			act(() => runBoardViewCommand({ kind: "pick", viewId: "ext:a" }));
			expect(await screen.findByTestId("view-ext:a")).toBeInTheDocument();
			act(() => runBoardViewCommand({ kind: "pick", viewId: "ext:missing" }));
			expect(info).toHaveBeenCalledTimes(1);
			expect(screen.getByTestId("view-ext:a")).toBeInTheDocument();
			info.mockRestore();
		});

		it("runs a command sent before the board mounted", async () => {
			startBoardViews([installKanbanView]);
			registerView("ext:a");
			runBoardViewCommand({ kind: "pick", viewId: "ext:a" });
			renderHost();
			expect(await screen.findByTestId("view-ext:a")).toBeInTheDocument();
		});
	});
});
