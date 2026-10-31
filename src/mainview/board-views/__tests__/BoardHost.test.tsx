import { StrictMode, memo, type Dispatch } from "react";
import type { AppAction } from "../../state";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Context } from "cordis";
import type { Project, Task } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";
import { setHiddenControlsForTests } from "../../hidden-controls";
import BoardHost from "../BoardHost";
import { getBoardRoot, getBoardViewRegistry, resetBoardRootForTests, startBoardViews } from "../root";
import { installKanbanView } from "../kanban";
import { useBoard } from "../react";
import { resetBoardViewStateCacheForTests } from "../useBoardViewState";
import { defaultBoardViewState, withViewType } from "../../../shared/board-view-state";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getAgents: vi.fn().mockResolvedValue([]),
			getProjectPRs: vi.fn().mockResolvedValue([]),
			getTaskLineage: vi.fn().mockResolvedValue({ nodes: [] }),
			getBoardViewState: vi.fn(),
			setBoardViewState: vi.fn(async ({ state }) => state),
			createLabel: vi.fn(),
		},
	},
}));

// The old Kanban is covered by its own suites (rendered through this host);
// here it only has to prove which tasks it was handed.
vi.mock("../../components/KanbanBoard", () => ({
	default: ({ tasks, displayTasks }: { tasks: Task[]; displayTasks: Task[] }) => (
		<div data-testid="kanban" data-total={tasks.length} data-shown={displayTasks.map((t) => t.id).join(",")} />
	),
}));

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

function renderHost(props: { tasks?: Task[]; strict?: boolean; dispatch?: Dispatch<AppAction> } = {}) {
	const tree = (list: Task[]) => (
		<I18nProvider>
			<BoardHost
				project={project}
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
});
