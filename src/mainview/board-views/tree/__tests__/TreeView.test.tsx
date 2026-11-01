import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Context } from "cordis";
import type { Project, Task } from "../../../../shared/types";
import { I18nProvider } from "../../../i18n";
import { BoardService, type BoardActions, type BoardAllActions, type BoardLineageNode, type BoardModel } from "../../board-service";
import { BoardViewSlot } from "../../BoardViewChrome";
import { BoardViewRegistry } from "../../registry";
import "../../root";
import { installTreeView, TREE_VIEW_ID } from "..";
import { TreeOptions } from "../TreeOptions";

vi.mock("../../../rpc", () => ({ api: { request: {} } }));

const alpha = {
	id: "p1", name: "Alpha", path: "/tmp/p1", setupScript: "", devScript: "", cleanupScript: "",
	defaultBaseBranch: "main", createdAt: "2026-01-01T00:00:00Z", labels: [], customColumns: [],
} as Project;

function task(id: string, seq: number, overrides: Partial<Task> = {}): Task {
	return {
		id, seq, projectId: "p1", title: `Task ${seq}`, description: "", status: "todo",
		baseBranch: "main", worktreePath: null, branchName: null, groupId: null, variantIndex: null,
		agentId: null, configId: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
		labelIds: [], ...overrides,
	} as Task;
}

const childOf = (parentId: string, projectId = "p1") => ({ origin: { kind: "task" as const, taskId: parentId, projectId } });

function actions(): { [K in keyof BoardActions]: ReturnType<typeof vi.fn> } {
	return {
		openTask: vi.fn(), openContextMenu: vi.fn(), moveTask: vi.fn(), setPriority: vi.fn(), setLabels: vi.fn(),
		createLabel: vi.fn(), createTask: vi.fn(), launch: vi.fn(), remove: vi.fn(),
	};
}

interface Setup {
	tasks?: Task[];
	scopeTasks?: Task[];
	query?: string;
	formFactor?: "wide" | "narrow";
	layout?: unknown;
	lineage?: Record<string, BoardLineageNode>;
}

async function renderTree(setup: Setup = {}) {
	const layouts = new Map<string, unknown>(setup.layout ? [[TREE_VIEW_ID, setup.layout]] : []);
	const act$ = actions();
	const tasks = setup.tasks ?? [];
	const model: BoardModel = {
		scope: { kind: "project", id: "p1", projectIds: ["p1"] },
		formFactor: setup.formFactor ?? "wide",
		query: setup.query ?? "",
		setQuery: vi.fn(),
		scopeTasks: setup.scopeTasks ?? tasks,
		tasks,
		matches: () => false,
		lineageNode: (id) => setup.lineage?.[id] ?? "deleted",
		columns: [],
		occupiedColumns: [],
		labels: [],
		agents: [],
		projects: [alpha],
		layout: (id) => layouts.get(id),
		setLayout: vi.fn((id: string, layout: unknown) => layouts.set(id, layout)),
		preferences: { taskSortOrder: "newest-first", tipsDisabled: true },
		actions: act$ as unknown as BoardAllActions,
	};
	const root = new Context();
	new BoardViewRegistry(root);
	root.provide("board", new BoardService({ current: model }, () => null));
	installTreeView(root);
	const view = await vi.waitFor(() => root.boardViews.get(TREE_VIEW_ID) ?? Promise.reject(new Error("not registered")));
	const ui$ = render(
		<I18nProvider>
			<BoardViewSlot ctx={view.ctx} component={view.def.component} />
		</I18nProvider>,
	);
	const rerender = () => act(() => {
		root.emit("board/changed");
	});
	const renderOptions = () => render(
		<I18nProvider>
			<BoardViewSlot ctx={view.ctx} component={TreeOptions} />
		</I18nProvider>,
	);
	return { ...ui$, view, model, actions: act$, layouts, rerender, renderOptions };
}

beforeAll(() => {
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
});
afterAll(() => {
	vi.restoreAllMocks();
});

const rowKeys = () => screen.queryAllByRole("treeitem").map((el) => el.dataset.testid!.replace("board-tree-row-", ""));

const family = [
	task("root", 1, { title: "Coordinate" }),
	task("kid", 2, childOf("root")),
	task("grandkid", 3, childOf("kid")),
	task("solo", 4),
];

describe("Tree board view", () => {
	it("registers as builtin:tree with narrow support and a View options panel", async () => {
		const { view } = await renderTree();
		expect(view.def).toMatchObject({ id: "builtin:tree", label: "boardView.tree", supportsNarrow: true, Options: TreeOptions });
		expect(screen.getByTestId("board-tree-empty")).toHaveTextContent("No tasks on this board yet.");
	});

	it("tells a filtered-out board apart from an empty one", async () => {
		await renderTree({ tasks: [], scopeTasks: [task("t1", 1)] });
		expect(screen.getByTestId("board-tree-empty")).toHaveTextContent("No tasks match the filter.");
	});

	it("starts collapsed: roots only, newest first, with a count of what is inside", async () => {
		await renderTree({ tasks: family });
		expect(rowKeys()).toEqual(["p1#4", "p1#1"]);
		const root = screen.getByTestId("board-tree-row-p1#1");
		expect(root).toHaveAttribute("aria-expanded", "false");
		expect(within(root).getByText("+2 inside")).toBeInTheDocument();
	});

	it("expands from the chevron and persists the open node in the view layout", async () => {
		const { layouts, rerender, actions } = await renderTree({ tasks: family });
		fireEvent.click(screen.getByTestId("board-tree-toggle-p1#1"));
		expect(layouts.get(TREE_VIEW_ID)).toEqual({ groupBy: "none", expanded: ["p1#1"], lineageOnly: false });
		rerender();
		expect(rowKeys()).toEqual(["p1#4", "p1#1", "p1#2"]);
		expect(actions.openTask).not.toHaveBeenCalled();
	});

	it("opens a task on click and its context menu on right-click", async () => {
		const { actions } = await renderTree({ tasks: family });
		fireEvent.click(screen.getByTestId("board-tree-row-p1#1"));
		expect(actions.openTask).toHaveBeenCalledWith("root");
		fireEvent.contextMenu(screen.getByTestId("board-tree-row-p1#4"), { clientX: 5, clientY: 6 });
		expect(actions.openContextMenu).toHaveBeenCalledWith("solo", { x: 5, y: 6 });
	});

	it("drives expand and collapse from the keyboard like a tree", async () => {
		const { layouts, rerender } = await renderTree({ tasks: family });
		fireEvent.keyDown(screen.getByTestId("board-tree-row-p1#1"), { key: "ArrowRight" });
		expect((layouts.get(TREE_VIEW_ID) as { expanded: string[] }).expanded).toEqual(["p1#1"]);
		rerender();
		fireEvent.keyDown(screen.getByTestId("board-tree-row-p1#1"), { key: "ArrowLeft" });
		expect((layouts.get(TREE_VIEW_ID) as { expanded: string[] }).expanded).toEqual([]);
	});

	it("shows a parent from another project as a ghost that never opens", async () => {
		const far: BoardLineageNode = { id: "far", projectId: "p9", projectName: "Elsewhere", seq: 900, variantIndex: null, status: "todo", title: "Far plan" };
		const { actions } = await renderTree({ tasks: [task("a", 1, childOf("far", "p9"))], lineage: { far } });
		const ghost = screen.getByTestId("board-tree-row-ghost:p9#900");
		expect(ghost).toHaveAttribute("data-ghost");
		expect(within(ghost).getByText("Far plan")).toBeInTheDocument();
		expect(within(ghost).getByText("Elsewhere")).toBeInTheDocument();
		fireEvent.click(ghost);
		expect(actions.openTask).not.toHaveBeenCalled();
	});

	it("collapses variants into one row with a dot per attempt", async () => {
		await renderTree({ tasks: [task("v1", 7, { groupId: "g", variantIndex: 1 }), task("v2", 7, { groupId: "g", variantIndex: 2 })] });
		expect(rowKeys()).toEqual(["p1#7"]);
		expect(screen.getByRole("img", { name: "2 variants" })).toBeInTheDocument();
	});

	it("opens ancestors of a query hit and dims them as context", async () => {
		await renderTree({ tasks: [family[2]], scopeTasks: family, query: "Task 3" });
		expect(rowKeys()).toEqual(["p1#1", "p1#2", "p1#3"]);
		expect(screen.getByTestId("board-tree-row-p1#1").firstElementChild).toHaveClass("opacity-60");
	});

	it("caps the narrow outline's indent at three levels and labels deeper rows", async () => {
		const chain = [task("t0", 1), ...[2, 3, 4, 5].map((seq) => task(`t${seq - 1}`, seq, childOf(`t${seq - 2}`)))];
		await renderTree({ tasks: chain, formFactor: "narrow", layout: { expanded: ["p1#1", "p1#2", "p1#3", "p1#4"] } });
		const deepest = screen.getByTestId("board-tree-row-p1#5");
		expect(deepest).toHaveAttribute("aria-level", "5");
		expect(within(deepest).getByText("L5")).toBeInTheDocument();
		expect((deepest.firstElementChild as HTMLElement).style.paddingInlineStart).toBe("3.75rem");
	});

	it("View options: lineage-only hides standalone roots; expand all and collapse all", async () => {
		const { layouts, renderOptions, rerender } = await renderTree({ tasks: family });
		renderOptions();
		fireEvent.click(screen.getByTestId("board-tree-option-lineage-only"));
		rerender();
		expect(rowKeys()).toEqual(["p1#1"]);
		fireEvent.click(screen.getByTestId("board-tree-expand-all"));
		expect((layouts.get(TREE_VIEW_ID) as { expanded: string[] }).expanded).toEqual(["p1#1", "p1#2"]);
		rerender();
		expect(rowKeys()).toEqual(["p1#1", "p1#2", "p1#3"]);
		fireEvent.click(screen.getByTestId("board-tree-collapse-all"));
		rerender();
		expect(rowKeys()).toEqual(["p1#1"]);
	});
});
