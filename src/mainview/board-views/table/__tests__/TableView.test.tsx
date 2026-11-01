import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Context } from "cordis";
import type { BoardColumnSlot, CodingAgent, Label, Project, Task } from "../../../../shared/types";
import { I18nProvider } from "../../../i18n";
import { BoardService, type BoardActions, type BoardAllActions, type BoardModel } from "../../board-service";
import { BoardViewSlot } from "../../BoardViewChrome";
import { BoardViewRegistry } from "../../registry";
import "../../root";
import { installTableView, TABLE_VIEW_ID } from "..";
import { TableOptions } from "../TableOptions";

vi.mock("../../../rpc", () => ({ api: { request: {} } }));

const bug: Label = { id: "l-bug", name: "Bug", color: "#f00" };
const ui: Label = { id: "l-ui", name: "UI", color: "#0f0" };
const qa = { id: "c-qa", name: "QA", color: "#abc" };

function project(id: string, name: string): Project {
	return {
		id, name, path: `/tmp/${id}`, setupScript: "", devScript: "", cleanupScript: "",
		defaultBaseBranch: "main", createdAt: "2026-01-01T00:00:00Z", labels: [bug, ui], customColumns: [qa],
	} as Project;
}

function task(id: string, seq: number, overrides: Partial<Task> = {}): Task {
	return {
		id, seq, projectId: "p1", title: `Task ${seq}`, description: "", status: "todo",
		baseBranch: "main", worktreePath: null, branchName: null, groupId: null, variantIndex: null,
		agentId: null, configId: null, createdAt: `2026-10-${String(seq).padStart(2, "0")}T00:00:00Z`,
		updatedAt: "2026-10-01T00:00:00Z", labelIds: [], ...overrides,
	} as Task;
}

const columns: BoardColumnSlot[] = [
	{ type: "builtin", status: "todo" },
	{ type: "builtin", status: "in-progress" },
	{ type: "custom", col: qa as never, members: [{ projectId: "p1", columnId: "c-qa" }] },
	{ type: "builtin", status: "completed" },
	{ type: "builtin", status: "cancelled" },
];

const agents = [{ id: "a1", name: "Claude", baseCommand: "claude", configurations: [] }] as CodingAgent[];

function actions(): { [K in keyof BoardActions]: ReturnType<typeof vi.fn> } {
	return {
		openTask: vi.fn(), openContextMenu: vi.fn(), moveTask: vi.fn().mockResolvedValue(undefined),
		setPriority: vi.fn().mockResolvedValue(undefined), setLabels: vi.fn().mockResolvedValue(undefined),
		createLabel: vi.fn(), createTask: vi.fn(), launch: vi.fn(), remove: vi.fn(),
	};
}

interface Setup {
	tasks?: Task[];
	scopeTasks?: Task[];
	kind?: "project" | "space";
	formFactor?: "wide" | "narrow";
	layout?: unknown;
	matches?: (task: Task, query: string) => boolean;
}

/** The view under test in a real Cordis context, with a fake `ctx.board` (the board contract seam). */
async function renderTable(setup: Setup = {}) {
	const layouts = new Map<string, unknown>(setup.layout ? [[TABLE_VIEW_ID, setup.layout]] : []);
	const act$ = actions();
	const ops = { ...project("ops", "Operations"), kind: "virtual", builtin: true } as Project;
	const projects = setup.kind === "space" ? [project("p1", "Alpha"), project("p2", "Beta"), ops] : [project("p1", "Alpha")];
	const tasks = setup.tasks ?? [];
	const model: BoardModel = {
		scope: { kind: setup.kind ?? "project", id: "b1", projectIds: projects.map((p) => p.id) },
		formFactor: setup.formFactor ?? "wide",
		query: "",
		setQuery: vi.fn(),
		scopeTasks: setup.scopeTasks ?? tasks,
		tasks,
		matches: setup.matches ?? (() => false),
		lineageNode: () => null,
		columns,
		occupiedColumns: columns,
		labels: [bug, ui],
		agents,
		projects,
		layout: (id) => layouts.get(id),
		setLayout: vi.fn((id: string, layout: unknown) => layouts.set(id, layout)),
		preferences: { taskSortOrder: "newest-first", tipsDisabled: true },
		actions: act$ as unknown as BoardAllActions,
	};
	const root = new Context();
	new BoardViewRegistry(root);
	root.provide("board", new BoardService({ current: model }, () => null));
	installTableView(root);
	// Cordis applies a plugin asynchronously, once its injected services are ready.
	const view = await vi.waitFor(() => root.boardViews.get(TABLE_VIEW_ID) ?? Promise.reject(new Error("not registered")));
	const ui$ = render(
		<I18nProvider>
			<BoardViewSlot ctx={view.ctx} component={view.def.component} />
		</I18nProvider>,
	);
	const rerender = () => {
		act(() => {
			root.emit("board/changed");
		});
	};
	const renderOptions = () => render(
		<I18nProvider>
			<BoardViewSlot ctx={view.ctx} component={TableOptions} />
		</I18nProvider>,
	);
	return { ...ui$, view, model, actions: act$, layouts, rerender, renderOptions };
}

// happy-dom has no layout: give every element a desktop-sized box so the
// virtualiser sees a real viewport and mounts a screenful of rows.
beforeAll(() => {
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
});
afterAll(() => {
	vi.restoreAllMocks();
});

const rowIds = () => screen.getAllByTestId(/^board-table-row-/).map((el) => el.dataset.testid!.replace("board-table-row-", ""));

describe("Table board view", () => {
	it("registers as builtin:table with narrow support and a View options panel", async () => {
		const { view } = await renderTable();
		expect(view.def).toMatchObject({ id: "builtin:table", label: "boardView.table", supportsNarrow: true, Options: TableOptions });
		expect(screen.getByTestId("board-table-empty")).toHaveTextContent("No tasks on this board yet.");
	});

	it("tells a filtered-out board apart from an empty one", async () => {
		await renderTable({ tasks: [], scopeTasks: [task("t1", 1)] });
		expect(screen.getByTestId("board-table-empty")).toHaveTextContent("No tasks match the filter.");
	});

	it("shows the default columns and every task, finished ones included, newest activity first", async () => {
		await renderTable({ tasks: [task("t1", 1), task("t3", 3, { status: "completed" }), task("t2", 2, { status: "cancelled" })] });
		const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
		expect(headers).toEqual(["#", "Title", "Status", "Priority", "Labels", "Agent", "PR", "Activity"]);
		expect(rowIds()).toEqual(["t3", "t2", "t1"]);
		expect(within(screen.getByTestId("board-table-row-t2")).getByText("Cancelled")).toBeInTheDocument();
	});

	it("labels variants with their attempt suffix, like the card", async () => {
		await renderTable({ tasks: [task("v1", 7, { variantIndex: 1, groupId: "g" }), task("v2", 7, { variantIndex: 2, groupId: "g" })] });
		expect(within(screen.getByTestId("board-table-row-v2")).getByText("#7-2")).toBeInTheDocument();
	});

	it("drops the suffix of a variant that is alone on the board", async () => {
		await renderTable({ tasks: [task("v1", 7, { variantIndex: 1, groupId: "g" })] });
		expect(within(screen.getByTestId("board-table-row-v1")).getByText("#7")).toBeInTheDocument();
	});

	it("adds the project column on a space board", async () => {
		await renderTable({ kind: "space", tasks: [task("t1", 1, { projectId: "p2" })] });
		expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toContain("Project");
		expect(within(screen.getByTestId("board-table-row-t1")).getByText("Beta")).toBeInTheDocument();
	});

	it("names the built-in ops board the way the rest of the app does", async () => {
		await renderTable({ kind: "space", tasks: [task("t1", 1, { projectId: "ops" })] });
		expect(within(screen.getByTestId("board-table-row-t1")).getByText("[ Operations ]")).toBeInTheDocument();
	});

	it("sorts by a header click, persists the sort through ctx.board, and flips on a second click", async () => {
		const { model, rerender } = await renderTable({ tasks: [task("t1", 1, { title: "beta" }), task("t2", 2, { title: "Alpha" })] });
		fireEvent.click(screen.getByTestId("board-table-sort-title"));
		expect(model.setLayout).toHaveBeenLastCalledWith(TABLE_VIEW_ID, expect.objectContaining({ sort: ["title", "asc"] }));
		rerender();
		expect(rowIds()).toEqual(["t2", "t1"]);
		expect(screen.getAllByRole("columnheader")[1]).toHaveAttribute("aria-sort", "ascending");
		fireEvent.click(screen.getByTestId("board-table-sort-title"));
		rerender();
		expect(rowIds()).toEqual(["t1", "t2"]);
	});

	it("restores a saved layout and ignores what it does not understand", async () => {
		await renderTable({ tasks: [task("t1", 1, { branchName: "feat/x" })], layout: { columns: ["seq", "branch", "nonsense"], sort: ["seq", "asc"] } });
		expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["#", "Title", "Branch"]);
		expect(screen.getByText("feat/x")).toBeInTheDocument();
	});

	it("opens the task on click and Enter, and the card context menu on right-click and the menu key", async () => {
		const { actions } = await renderTable({ tasks: [task("t1", 1)] });
		const row = screen.getByTestId("board-table-row-t1");
		fireEvent.click(row);
		fireEvent.keyDown(row, { key: "Enter" });
		expect(actions.openTask).toHaveBeenCalledTimes(2);
		expect(actions.openTask).toHaveBeenCalledWith("t1");
		fireEvent.contextMenu(row, { clientX: 40, clientY: 50 });
		expect(actions.openContextMenu).toHaveBeenCalledWith("t1", { x: 40, y: 50 });
		fireEvent.keyDown(row, { key: "ContextMenu" });
		expect(actions.openContextMenu).toHaveBeenCalledTimes(2);
	});

	it("changes priority with the card's picker without opening the task", async () => {
		const { actions } = await renderTable({ tasks: [task("t1", 1, { priority: "P3" })] });
		fireEvent.click(within(screen.getByTestId("board-table-row-t1")).getByRole("button", { name: /P3/ }));
		fireEvent.click(screen.getByRole("menuitemradio", { name: /P0/ }));
		expect(actions.setPriority).toHaveBeenCalledWith("t1", "P0");
		expect(actions.openTask).not.toHaveBeenCalled();
	});

	it("moves a task to a status or a custom column through ctx.board", async () => {
		const { actions } = await renderTable({ tasks: [task("t1", 1)] });
		const row = screen.getByTestId("board-table-row-t1");
		fireEvent.click(within(row).getByRole("button", { name: /Change status/ }));
		fireEvent.click(screen.getByRole("button", { name: /^Completed/ }));
		expect(actions.moveTask).toHaveBeenCalledWith("t1", { status: "completed" }, undefined);
		fireEvent.click(within(row).getByRole("button", { name: /Change status/ }));
		fireEvent.click(screen.getByRole("button", { name: /^QA/ }));
		expect(actions.moveTask).toHaveBeenCalledWith("t1", { customColumnId: "c-qa" }, undefined);
		expect(actions.openTask).not.toHaveBeenCalled();
	});

	it("shows a custom column's name as the status", async () => {
		await renderTable({ tasks: [task("t1", 1, { status: "in-progress", customColumnId: "c-qa" })] });
		expect(within(screen.getByTestId("board-table-row-t1")).getByRole("button", { name: /Status: QA/ })).toBeInTheDocument();
	});

	it("toggles labels and creates a new one in the task's own project", async () => {
		const { actions } = await renderTable({ tasks: [task("t1", 1, { labelIds: ["l-bug"] })] });
		actions.createLabel.mockResolvedValue({ id: "l-new", name: "Perf", color: "#00f" });
		fireEvent.click(within(screen.getByTestId("board-table-row-t1")).getByRole("button", { name: "Edit labels" }));
		fireEvent.click(screen.getByText("UI"));
		expect(actions.setLabels).toHaveBeenCalledWith("t1", ["l-bug", "l-ui"]);
		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: "Perf" } });
		await act(async () => {
			fireEvent.keyDown(input, { key: "Enter" });
		});
		expect(actions.createLabel).toHaveBeenCalledWith("p1", "Perf");
		expect(actions.setLabels).toHaveBeenLastCalledWith("t1", ["l-bug", "l-new"]);
	});

	it("shows the PR number with the state the shared pr: tokens report", async () => {
		await renderTable({
			tasks: [task("t1", 1, { prNumber: 42 })],
			matches: (_task, query) => query === "pr:merged",
		});
		expect(within(screen.getByTestId("board-table-row-t1")).getByText("#42")).toHaveTextContent("#42merged");
	});

	it("renders a card list on narrow", async () => {
		await renderTable({ formFactor: "narrow", tasks: [task("t1", 1), task("t2", 2)] });
		expect(screen.getByRole("list")).toBeInTheDocument();
		expect(screen.queryByRole("table")).not.toBeInTheDocument();
		expect(rowIds()).toEqual(["t2", "t1"]);
	});

	it("virtualises: a big board mounts only a screenful of rows", async () => {
		const many = Array.from({ length: 2400 }, (_, i) => task(`t${i + 1}`, i + 1));
		await renderTable({ tasks: many });
		const mounted = rowIds().length;
		expect(mounted).toBeGreaterThan(10);
		expect(mounted).toBeLessThan(100);
		expect(screen.getByRole("table")).toHaveAttribute("aria-rowcount", "2401");
	});

	describe("View options", () => {
		it("toggles a column, keeps the title locked, and offers Project only on space boards", async () => {
			const { model, renderOptions } = await renderTable({ tasks: [task("t1", 1)] });
			renderOptions();
			const options = screen.getByTestId("board-table-options");
			expect(within(options).getByLabelText("Title")).toBeDisabled();
			expect(within(options).queryByLabelText("Project")).not.toBeInTheDocument();
			fireEvent.click(within(options).getByLabelText("Agent"));
			const saved = (model.setLayout as ReturnType<typeof vi.fn>).mock.lastCall![1];
			expect(saved.columns).not.toContain("agent");
		});

		it("sorts from the column list, the only sort control a narrow board has", async () => {
			const { model, renderOptions } = await renderTable({ formFactor: "narrow", tasks: [task("t1", 1)] });
			renderOptions();
			expect(screen.getByTestId("board-table-option-sort-activity")).toHaveAttribute("aria-pressed", "true");
			fireEvent.click(screen.getByTestId("board-table-option-sort-activity"));
			expect(model.setLayout).toHaveBeenLastCalledWith(TABLE_VIEW_ID, expect.objectContaining({ sort: ["activity", "asc"] }));
			fireEvent.click(screen.getByTestId("board-table-option-sort-priority"));
			expect(model.setLayout).toHaveBeenLastCalledWith(TABLE_VIEW_ID, expect.objectContaining({ sort: ["priority", "asc"] }));
			expect(within(screen.getByTestId("board-table-options")).queryByRole("checkbox")).not.toBeInTheDocument();
		});

		it("offers the project column on a space board", async () => {
			const { renderOptions } = await renderTable({ kind: "space", tasks: [task("t1", 1)] });
			renderOptions();
			expect(within(screen.getByTestId("board-table-options")).getByLabelText("Project")).toBeChecked();
		});
	});
});
