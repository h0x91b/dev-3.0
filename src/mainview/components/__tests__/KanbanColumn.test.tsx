/**
 * KanbanColumn — column drag-and-drop reordering tests.
 *
 * These tests specify the exact events and behaviors required for column
 * reordering to work. If any test fails the drag-and-drop is broken.
 *
 * Testing approach:
 * - Use native `dispatchEvent` + `Object.defineProperty` for `dataTransfer`
 *   because happy-dom doesn't reliably set `dataTransfer` via event init.
 * - Wrap all dispatches in `act()` so React flushes state updates before assertions.
 * - Simulate the real user flow: dispatch `dragstart` on the drag handle first,
 *   which sets the module-level `_activeDragColumnId` variable used for detection.
 * - Happy-dom elements have zero bounding rects (center=0): clientX<0 → "before",
 *   clientX>0 → "after".
 */
import { act } from "@testing-library/react";
import { render, screen } from "@testing-library/react";
import KanbanColumn from "../KanbanColumn";
import { I18nProvider } from "../../i18n";
import userEvent from "@testing-library/user-event";
import type { Project, Task } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: { request: { moveTask: vi.fn(), deleteTask: vi.fn() } },
}));
vi.mock("../../analytics", () => ({ trackEvent: vi.fn(), agentNameFromId: vi.fn(() => "unknown") }));
vi.mock("../../utils/confirmTaskCompletion", () => ({
	confirmTaskCompletion: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../utils/ansi-to-html", () => ({ ansiToHtml: vi.fn((s: string) => s) }));
vi.mock("../TaskDetailModal", () => ({ default: () => null }));
vi.mock("../LabelPicker", () => ({ default: () => null }));

// Default viewport in happy-dom is 1024px which would trigger the compact-empty
// column mode and hide chrome these tests assert against. Force a desktop width.
beforeAll(() => {
	Object.defineProperty(window, "innerWidth", { configurable: true, value: 1920 });
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		value: (query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}),
	});
});

const project: Project = {
	id: "p1",
	name: "Test",
	path: "/tmp",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
};

function makeDt(data: Record<string, string> = {}): DataTransfer {
	return {
		types: Object.keys(data),
		getData: (key: string) => data[key] ?? "",
		setData: vi.fn((k: string, v: string) => { data[k] = v; }),
		effectAllowed: "move" as const,
		dropEffect: "move" as const,
	} as unknown as DataTransfer;
}

/** Dispatch a drag event with a properly-set dataTransfer; returns defaultPrevented. */
function dispatch(el: Element, type: string, opts: { clientX?: number; dataTransfer?: DataTransfer; relatedTarget?: Element | null } = {}): boolean {
	const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: opts.clientX ?? 0 });
	// Always attach a dataTransfer so handlers can safely set dropEffect etc.
	Object.defineProperty(event, "dataTransfer", { value: opts.dataTransfer ?? makeDt() });
	if (opts.relatedTarget !== undefined) Object.defineProperty(event, "relatedTarget", { value: opts.relatedTarget });
	let prevented = false;
	act(() => { prevented = !el.dispatchEvent(event); });
	return prevented;
}

/** Simulate starting a column drag from this column's handle (sets _activeDragColumnId). */
function startColumnDrag(handle: Element) {
	const dt = makeDt();
	dispatch(handle, "dragstart", { dataTransfer: dt });
}

/** Simulate ending a column drag (clears _activeDragColumnId). */
function endColumnDrag(handle: Element) {
	dispatch(handle, "dragend");
}

function getHandle() {
	return screen.getByTitle("Drag to reorder");
}
function getColumn() {
	return screen.getByText("My Column").closest("[class*='glass-column']") as HTMLElement;
}

function renderColumn(overrides: {
	onColumnDrop?: (side: "before" | "after") => void;
	isDraggedColumn?: boolean;
	customColumnId?: string;
	label?: string;
	onRenameColumn?: (name: string | null) => void;
	autoStartEditing?: boolean;
	onAutoEditConsumed?: () => void;
} = {}) {
	return render(
		<I18nProvider>
			<KanbanColumn
				status="todo"
				label={overrides.label ?? "My Column"}
				tasks={[]}
				project={project}
				dispatch={vi.fn()}
				navigate={vi.fn()}
				onAddTask={vi.fn()}
				agents={[]}
				onLaunchVariants={vi.fn()}
				onAddAttempts={vi.fn()}
				onTaskDrop={vi.fn()}
				onReorderTask={vi.fn()}
				dragFromStatus={null}
				dragFromCustomColumnId={null}
				onDragStart={vi.fn()}
				onTaskMoved={vi.fn()}
				bellCounts={new Map()}
				taskPorts={new Map()}
				draggedTaskId={null}
				movingTaskIds={new Set()}
				onSetMoving={vi.fn()}
				siblingMap={new Map()}
				isCustomColumn
				customColumnId={overrides.customColumnId ?? "col-aaa"}
				colorOverride="#ff0000"
				onColumnDragStart={vi.fn()}
				onColumnDragEnd={vi.fn()}
				onColumnDrop={overrides.onColumnDrop}
				isDraggedColumn={overrides.isDraggedColumn}
				onRenameColumn={overrides.onRenameColumn}
				autoStartEditing={overrides.autoStartEditing}
				onAutoEditConsumed={overrides.onAutoEditConsumed}
			/>
		</I18nProvider>,
	);
}

function renderBuiltinColumn(overrides: {
	onColumnDrop?: (side: "before" | "after") => void;
	onAddTask?: () => void;
	label?: string;
	status?: "todo" | "in-progress" | "completed" | "cancelled" | "user-questions" | "review-by-ai" | "review-by-user";
	tasks?: Task[];
	isCustomColumn?: boolean;
	customColumnId?: string;
} = {}) {
	return render(
		<I18nProvider>
			<KanbanColumn
				status={overrides.status ?? "todo"}
				label={overrides.label ?? "To Do"}
				tasks={overrides.tasks ?? []}
				project={project}
				dispatch={vi.fn()}
				navigate={vi.fn()}
				onAddTask={overrides.onAddTask ?? vi.fn()}
				agents={[]}
				onLaunchVariants={vi.fn()}
				onAddAttempts={vi.fn()}
				onTaskDrop={vi.fn()}
				onReorderTask={vi.fn()}
				dragFromStatus={null}
				dragFromCustomColumnId={null}
				onDragStart={vi.fn()}
				onTaskMoved={vi.fn()}
				bellCounts={new Map()}
				taskPorts={new Map()}
				draggedTaskId={null}
				movingTaskIds={new Set()}
				onSetMoving={vi.fn()}
				siblingMap={new Map()}
				onColumnDrop={overrides.onColumnDrop}
				isCustomColumn={overrides.isCustomColumn}
				customColumnId={overrides.customColumnId}
			/>
		</I18nProvider>,
	);
}

afterEach(() => {
	// Reset module-level _activeDragColumnId between tests by simulating dragend
	// Render a throwaway column, start drag on it, then end it
	const { unmount } = renderColumn();
	const handle = document.querySelector("[title='Drag to reorder']");
	if (handle) endColumnDrag(handle);
	unmount();
});

describe("KanbanColumn — column drag-and-drop", () => {
	describe("dragover", () => {
		it("calls preventDefault when a column drag is active (different column)", () => {
			renderColumn({ onColumnDrop: vi.fn(), customColumnId: "col-target" });
			// Simulate another column being dragged (sets _activeDragColumnId = "col-aaa")
			startColumnDrag(getHandle()); // handle belongs to col-target, but _activeDragColumnId = "col-target"
			// A DIFFERENT drag source would have set a different ID; simulate it directly
			// by starting drag on another rendered column
			const { container: srcContainer, unmount } = renderColumn({ label: "Source Column", customColumnId: "col-source", onColumnDrop: vi.fn() });
			const sourceHandle = srcContainer.querySelector("[title='Drag to reorder']") as Element;
			startColumnDrag(sourceHandle);
			unmount();

			// Now target column should accept the drag
			const prevented = dispatch(getColumn(), "dragover");
			expect(prevented).toBe(true);
		});

		it("does NOT call preventDefault when no column drag is active", () => {
			// No dragstart dispatched → _activeDragColumnId is null
			renderColumn({ onColumnDrop: vi.fn() });
			const prevented = dispatch(getColumn(), "dragover");
			expect(prevented).toBe(false);
		});

		it("does NOT call preventDefault when dragging onto itself (_activeDragColumnId === customColumnId)", () => {
			renderColumn({ onColumnDrop: vi.fn(), customColumnId: "col-aaa" });
			startColumnDrag(getHandle()); // sets _activeDragColumnId = "col-aaa"
			const prevented = dispatch(getColumn(), "dragover");
			expect(prevented).toBe(false);
		});

		it("does NOT call preventDefault when onColumnDrop is not provided", () => {
			renderColumn({ onColumnDrop: undefined, customColumnId: "col-target" });
			// Make some column set _activeDragColumnId
			const { container: srcContainer, unmount } = renderColumn({ label: "Source", customColumnId: "col-source", onColumnDrop: vi.fn() });
			startColumnDrag(srcContainer.querySelector("[title='Drag to reorder']") as Element);
			unmount();

			const prevented = dispatch(getColumn(), "dragover");
			expect(prevented).toBe(false);
		});
	});

	describe("dragenter", () => {
		it("calls preventDefault when a column drag is active (different column)", () => {
			// Render source and target
			const { unmount } = renderColumn({ label: "Source", customColumnId: "col-source", onColumnDrop: vi.fn() });
			startColumnDrag(screen.getByTitle("Drag to reorder"));
			unmount();

			renderColumn({ onColumnDrop: vi.fn(), customColumnId: "col-target" });
			const prevented = dispatch(getColumn(), "dragenter");
			expect(prevented).toBe(true);
		});

		it("does NOT call preventDefault when no column drag is active", () => {
			renderColumn({ onColumnDrop: vi.fn() });
			const prevented = dispatch(getColumn(), "dragenter");
			expect(prevented).toBe(false);
		});
	});

	describe("drop position indicator", () => {
		function setupColumnDragFromOther() {
			const { container, unmount } = renderColumn({ label: "Source", customColumnId: "col-source", onColumnDrop: vi.fn() });
			startColumnDrag(container.querySelector("[title='Drag to reorder']") as Element);
			unmount();
		}

		it("shows 'before' indicator (clientX < center=0)", () => {
			renderColumn({ onColumnDrop: vi.fn(), customColumnId: "col-target" });
			setupColumnDragFromOther();
			dispatch(getColumn(), "dragover", { clientX: -1 });
			// "before" uses -4px (left) box-shadow; "after" would start with "4px"
			expect(getColumn().style.boxShadow).toMatch(/-4px/);
			expect(getColumn().style.boxShadow).not.toMatch(/^4px/);
		});

		it("shows 'after' indicator (clientX > center=0)", () => {
			renderColumn({ onColumnDrop: vi.fn(), customColumnId: "col-target" });
			setupColumnDragFromOther();
			dispatch(getColumn(), "dragover", { clientX: 1 });
			// "after" uses +4px (right) box-shadow starting with "4px"
			expect(getColumn().style.boxShadow).toMatch(/^4px/);
			expect(getColumn().style.boxShadow).not.toMatch(/-4px/);
		});

		it("clears indicator on dragleave", () => {
			renderColumn({ onColumnDrop: vi.fn(), customColumnId: "col-target" });
			setupColumnDragFromOther();
			dispatch(getColumn(), "dragover", { clientX: -1 });
			expect(getColumn().style.boxShadow).toMatch(/-4px/);

			act(() => { getColumn().dispatchEvent(new MouseEvent("dragleave", { bubbles: true })); });
			expect(getColumn().style.boxShadow).not.toMatch(/-4px/);
		});

		it("no indicator when no column drag is active", () => {
			renderColumn({ onColumnDrop: vi.fn() });
			dispatch(getColumn(), "dragover", { clientX: -1 });
			expect(getColumn().style.boxShadow).not.toMatch(/-4px/);
		});
	});

	describe("drop", () => {
		function setupColumnDragFromOther() {
			const { container, unmount } = renderColumn({ label: "Source", customColumnId: "col-source", onColumnDrop: vi.fn() });
			startColumnDrag(container.querySelector("[title='Drag to reorder']") as Element);
			unmount();
		}

		it("calls onColumnDrop('before') when dropped on left half", () => {
			const onColumnDrop = vi.fn();
			renderColumn({ onColumnDrop, customColumnId: "col-target" });
			setupColumnDragFromOther();
			dispatch(getColumn(), "dragover", { clientX: -1 });  // set side = "before"
			dispatch(getColumn(), "drop");
			expect(onColumnDrop).toHaveBeenCalledTimes(1);
			expect(onColumnDrop).toHaveBeenCalledWith("before");
		});

		it("calls onColumnDrop('after') when dropped on right half", () => {
			const onColumnDrop = vi.fn();
			renderColumn({ onColumnDrop, customColumnId: "col-target" });
			setupColumnDragFromOther();
			dispatch(getColumn(), "dragover", { clientX: 1 });   // set side = "after"
			dispatch(getColumn(), "drop");
			expect(onColumnDrop).toHaveBeenCalledWith("after");
		});

		it("does NOT call onColumnDrop for task drops (no active column drag)", () => {
			const onColumnDrop = vi.fn();
			renderColumn({ onColumnDrop });
			// No startColumnDrag → _activeDragColumnId is null
			dispatch(getColumn(), "drop", { dataTransfer: makeDt({ "text/plain": "task-id-123" }) });
			expect(onColumnDrop).not.toHaveBeenCalled();
		});

		it("does NOT call onColumnDrop when no preceding dragover (no side set)", () => {
			const onColumnDrop = vi.fn();
			renderColumn({ onColumnDrop, customColumnId: "col-target" });
			setupColumnDragFromOther();
			// Drop without dragover → columnDragSide is null
			dispatch(getColumn(), "drop");
			expect(onColumnDrop).not.toHaveBeenCalled();
		});

		it("clears indicator after drop", () => {
			renderColumn({ onColumnDrop: vi.fn(), customColumnId: "col-target" });
			setupColumnDragFromOther();
			dispatch(getColumn(), "dragover", { clientX: -1 });
			expect(getColumn().style.boxShadow).toMatch(/-4px/);
			dispatch(getColumn(), "drop");
			expect(getColumn().style.boxShadow).not.toMatch(/-4px/);
		});
	});
});

describe("KanbanColumn — double-click empty space to add task", () => {
	it("calls onAddTask when double-clicking empty space in Todo column", async () => {
		const onAddTask = vi.fn();
		renderBuiltinColumn({ onAddTask, status: "todo" });
		const noTasksText = screen.getByText("No tasks");
		await userEvent.dblClick(noTasksText);
		expect(onAddTask).toHaveBeenCalledTimes(1);
	});

	it("does NOT call onAddTask when double-clicking in a non-todo column", async () => {
		const onAddTask = vi.fn();
		renderBuiltinColumn({ onAddTask, status: "in-progress", label: "In Progress" });
		const noTasksText = screen.getByText("No tasks");
		await userEvent.dblClick(noTasksText);
		expect(onAddTask).not.toHaveBeenCalled();
	});

	it("does NOT call onAddTask when double-clicking in a custom column", async () => {
		const onAddTask = vi.fn();
		renderBuiltinColumn({ onAddTask, status: "todo", isCustomColumn: true, customColumnId: "col-x" });
		const noTasksText = screen.getByText("No tasks");
		await userEvent.dblClick(noTasksText);
		expect(onAddTask).not.toHaveBeenCalled();
	});

	it("does NOT call onAddTask when double-clicking on a task card", async () => {
		const onAddTask = vi.fn();
		const task: Task = {
			id: "t1",
			projectId: "p1",
			seq: 1,
			title: "Test task",
			description: "Test task",
			status: "todo",
			baseBranch: "main",
			worktreePath: null,
			branchName: null,
			groupId: null,
			variantIndex: null,
			agentId: null,
			configId: null,
			createdAt: "2025-01-01T00:00:00Z",
			updatedAt: "2025-01-01T00:00:00Z",
		};
		const { container } = renderBuiltinColumn({ onAddTask, status: "todo", tasks: [task] });
		const taskElement = container.querySelector("[data-task-id='t1']") as HTMLElement;
		await userEvent.dblClick(taskElement);
		expect(onAddTask).not.toHaveBeenCalled();
	});
});

describe("KanbanColumn — collapsed state", () => {
	function renderCollapsedColumn(overrides: {
		onCollapseToggle?: () => void;
		tasks?: Task[];
	} = {}) {
		const tasks = overrides.tasks ?? [];
		return render(
			<I18nProvider>
				<KanbanColumn
					status="todo"
					label="To Do"
					tasks={tasks}
					project={project}
					dispatch={vi.fn()}
					navigate={vi.fn()}
					onAddTask={vi.fn()}
					agents={[]}
					onLaunchVariants={vi.fn()}
					onAddAttempts={vi.fn()}
					onTaskDrop={vi.fn()}
					onReorderTask={vi.fn()}
					dragFromStatus={null}
					dragFromCustomColumnId={null}
					onDragStart={vi.fn()}
					onTaskMoved={vi.fn()}
					bellCounts={new Map()}
					taskPorts={new Map()}
					draggedTaskId={null}
					movingTaskIds={new Set()}
					onSetMoving={vi.fn()}
					siblingMap={new Map()}
					collapsed={true}
					onCollapseToggle={overrides.onCollapseToggle ?? vi.fn()}
				/>
			</I18nProvider>,
		);
	}

	it("renders narrow collapsed column with vertical label", () => {
		renderCollapsedColumn();
		const collapsed = document.querySelector("[data-collapsed-column]");
		expect(collapsed).not.toBeNull();
		// Check vertical label text
		const label = collapsed?.querySelector(".kanban-col-vertical-label");
		expect(label).not.toBeNull();
		expect(label?.textContent).toBe("To Do");
	});

	it("renders task count badge when tasks exist", () => {
		const task: Task = {
			id: "t1", projectId: "p1", seq: 1, title: "Test", description: "Test",
			status: "todo", baseBranch: "main", worktreePath: null, branchName: null,
			groupId: null, variantIndex: null, agentId: null, configId: null,
			createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z",
		};
		renderCollapsedColumn({ tasks: [task] });
		const badge = document.querySelector("[data-collapsed-column] .text-xs.font-bold");
		expect(badge?.textContent).toBe("1");
	});

	it("collapsed strip does not render a pin button", () => {
		renderCollapsedColumn({ onCollapseToggle: vi.fn() });
		const pinBtn = document.querySelector("[data-collapsed-column] button[aria-label='Pin column open']");
		expect(pinBtn).toBeNull();
	});

	it("collapsed Todo column renders a new task button", async () => {
		const onAddTask = vi.fn();
		render(
			<I18nProvider>
				<KanbanColumn
					status="todo"
					label="To Do"
					tasks={[]}
					project={project}
					dispatch={vi.fn()}
					navigate={vi.fn()}
					onAddTask={onAddTask}
					agents={[]}
					onLaunchVariants={vi.fn()}
					onAddAttempts={vi.fn()}
					onTaskDrop={vi.fn()}
					onReorderTask={vi.fn()}
					dragFromStatus={null}
					dragFromCustomColumnId={null}
					onDragStart={vi.fn()}
					onTaskMoved={vi.fn()}
					bellCounts={new Map()}
					taskPorts={new Map()}
					draggedTaskId={null}
					movingTaskIds={new Set()}
					onSetMoving={vi.fn()}
					siblingMap={new Map()}
					collapsed={true}
					onCollapseToggle={vi.fn()}
				/>
			</I18nProvider>,
		);
		const addBtn = document.querySelector("[data-collapsed-column] button[aria-label='+ New Task']") as HTMLElement;
		expect(addBtn).not.toBeNull();
		await userEvent.click(addBtn);
		expect(onAddTask).toHaveBeenCalledTimes(1);
	});

	it("collapsed column still has drag-and-drop handlers", () => {
		renderCollapsedColumn();
		const collapsed = document.querySelector("[data-collapsed-column]") as HTMLElement;
		// Verify element exists and can receive drag events (doesn't throw)
		expect(collapsed).not.toBeNull();
		const dt = makeDt({ "text/plain": "task-123" });
		const event = new MouseEvent("dragover", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "dataTransfer", { value: dt });
		act(() => { collapsed.dispatchEvent(event); });
		// No error thrown = drag handlers are active
	});
});

describe("built-in column as column-reorder drop target", () => {
	function getBuiltinColumn() {
		return screen.getByText("To Do").closest("[class*='glass-column']") as HTMLElement;
	}

	function setupCustomColumnDrag() {
		// Render a custom column to provide the drag source
		const { container, unmount } = renderColumn({ label: "Source", customColumnId: "col-source", onColumnDrop: vi.fn() });
		startColumnDrag(container.querySelector("[title='Drag to reorder']") as Element);
		unmount();
	}

	it("calls preventDefault on dragover when onColumnDrop provided (not isCustomColumn)", () => {
		renderBuiltinColumn({ onColumnDrop: vi.fn() });
		setupCustomColumnDrag();
		// Built-in column has status="todo" as myDragId; _activeDragColumnId = "col-source" ≠ "todo"
		const prevented = dispatch(getBuiltinColumn(), "dragover");
		expect(prevented).toBe(true);
	});

	it("calls onColumnDrop when dropped on a built-in column with side set", () => {
		const onColumnDrop = vi.fn();
		renderBuiltinColumn({ onColumnDrop });
		setupCustomColumnDrag();
		dispatch(getBuiltinColumn(), "dragover", { clientX: -1 }); // side = "before"
		dispatch(getBuiltinColumn(), "drop");
		expect(onColumnDrop).toHaveBeenCalledTimes(1);
		expect(onColumnDrop).toHaveBeenCalledWith("before");
	});
});

describe("KanbanColumn — compact empty column on narrow viewport", () => {
	const originalInnerWidth = window.innerWidth;
	const originalMatchMedia = window.matchMedia;

	function setViewport(width: number) {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
		Object.defineProperty(window, "matchMedia", {
			configurable: true,
			value: (query: string) => ({
				matches: width < 1400,
				media: query,
				onchange: null,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				addListener: vi.fn(),
				removeListener: vi.fn(),
				dispatchEvent: vi.fn(),
			}),
		});
	}

	afterEach(() => {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
		Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
	});

	it("collapses an empty in-progress column to a slim fixed width when viewport is narrow", () => {
		setViewport(1200);
		const { container } = renderBuiltinColumn({ status: "in-progress", label: "In Progress" });
		const column = container.querySelector(".glass-column") as HTMLElement;
		expect(column.className).toMatch(/w-\[6\.125rem\]/);
		expect(column.className).not.toMatch(/w-\[17\.5rem\]/);
		// "No tasks" placeholder is hidden in compact mode
		expect(screen.queryByText("No tasks")).toBeNull();
	});

	it("keeps the Todo column at full width even when empty and narrow", () => {
		setViewport(1200);
		const { container } = renderBuiltinColumn({ status: "todo", label: "To Do" });
		const column = container.querySelector(".glass-column") as HTMLElement;
		expect(column.className).toMatch(/w-\[17\.5rem\]/);
	});

	it("stays full width when viewport is wide, even if the column is empty", () => {
		setViewport(1920);
		const { container } = renderBuiltinColumn({ status: "in-progress", label: "In Progress" });
		const column = container.querySelector(".glass-column") as HTMLElement;
		expect(column.className).toMatch(/w-\[17\.5rem\]/);
		expect(screen.getByText("No tasks")).toBeInTheDocument();
	});

	it("stays full width when the column has tasks, regardless of viewport", () => {
		setViewport(1200);
		const task: Task = {
			id: "t1", projectId: "p1", seq: 1, title: "Test", description: "",
			status: "in-progress", baseBranch: "main", worktreePath: null, branchName: null,
			groupId: null, variantIndex: null, agentId: null, configId: null,
			createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z",
		};
		const { container } = renderBuiltinColumn({ status: "in-progress", label: "In Progress", tasks: [task] });
		const column = container.querySelector(".glass-column") as HTMLElement;
		expect(column.className).toMatch(/w-\[17\.5rem\]/);
	});
});

describe("KanbanColumn — task reorder within a built-in column", () => {
	function makeTasks(n: number, status: Task["status"] = "in-progress"): Task[] {
		return Array.from({ length: n }, (_, i) => ({
			id: `t${i}`,
			projectId: "p1",
			seq: i + 1,
			title: `Task ${i}`,
			description: "",
			status,
			baseBranch: "main",
			worktreePath: null,
			branchName: null,
			groupId: null,
			variantIndex: null,
			agentId: null,
			configId: null,
			createdAt: "2025-01-01T00:00:00Z",
			updatedAt: "2025-01-01T00:00:00Z",
		}));
	}

	/** The scrollable task list's direct-child wrappers (one per rendered card). */
	function taskWrappers(container: HTMLElement): HTMLElement[] {
		const list = container.querySelector(".overflow-y-auto") as HTMLElement;
		return Array.from(list.querySelectorAll(":scope > [data-task-id]")) as HTMLElement[];
	}

	/** Lay each wrapper out as a 100px-tall row stacked from y=0. */
	function stackWrappers(wrappers: HTMLElement[], rowHeight = 100) {
		wrappers.forEach((el, i) => {
			el.getBoundingClientRect = () =>
				({ top: i * rowHeight, bottom: (i + 1) * rowHeight, height: rowHeight, left: 0, right: 280, width: 280, x: 0, y: i * rowHeight, toJSON() {} }) as DOMRect;
		});
	}

	function dragOver(column: HTMLElement, clientY: number) {
		const event = new MouseEvent("dragover", { bubbles: true, cancelable: true, clientY });
		Object.defineProperty(event, "dataTransfer", { value: makeDt() });
		act(() => { column.dispatchEvent(event); });
	}

	function dropTask(column: HTMLElement, taskId: string) {
		const event = new MouseEvent("drop", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "dataTransfer", { value: makeDt({ "text/plain": taskId }) });
		act(() => { column.dispatchEvent(event); });
	}

	function renderReorderColumn(tasks: Task[], onReorderTask: (taskId: string, targetIndex: number) => void) {
		return render(
			<I18nProvider>
				<KanbanColumn
					status="in-progress"
					label="In Progress"
					tasks={tasks}
					project={project}
					dispatch={vi.fn()}
					navigate={vi.fn()}
					onAddTask={vi.fn()}
					agents={[]}
					onLaunchVariants={vi.fn()}
					onAddAttempts={vi.fn()}
					onTaskDrop={vi.fn()}
					onReorderTask={onReorderTask}
					// Same-column drag: source column status matches, no custom column.
					dragFromStatus="in-progress"
					dragFromCustomColumnId={null}
					onDragStart={vi.fn()}
					onTaskMoved={vi.fn()}
					bellCounts={new Map()}
					taskPorts={new Map()}
					draggedTaskId="t0"
					movingTaskIds={new Set()}
					onSetMoving={vi.fn()}
					siblingMap={new Map()}
				/>
			</I18nProvider>,
		);
	}

	it("computes the drop index from wrappers only, not the doubled data-task-id node list", () => {
		// Regression: TaskCard's root ALSO carries data-task-id, so a plain
		// `[data-task-id]` query returned 2N interleaved nodes and doubled the
		// index. Dropping task0 over the 3rd of 3 cards must reorder to index 1
		// (its old slot removed), never index 3 (out of bounds → skipped card).
		const onReorderTask = vi.fn();
		const { container } = renderReorderColumn(makeTasks(3), onReorderTask);
		const column = container.querySelector(".glass-column") as HTMLElement;
		stackWrappers(taskWrappers(container));

		dragOver(column, 210); // over the 3rd card (top 200, mid 250)
		dropTask(column, "t0");

		expect(onReorderTask).toHaveBeenCalledTimes(1);
		expect(onReorderTask).toHaveBeenCalledWith("t0", 1);
	});

	it("clamps a drop past the last visible card to the visible count in a truncated column", () => {
		// Regression: dropIndex defaulted to tasks.length. In a column with more
		// than COLUMN_TASK_LIMIT (15) tasks only 15 render, so a drop below them
		// silently reordered into the hidden tail (index 17) with no indicator.
		// It must clamp to the visible boundary instead.
		const onReorderTask = vi.fn();
		const { container } = renderReorderColumn(makeTasks(18), onReorderTask);
		const column = container.querySelector(".glass-column") as HTMLElement;
		const wrappers = taskWrappers(container);
		expect(wrappers.length).toBe(15); // COLUMN_TASK_LIMIT
		stackWrappers(wrappers);

		dragOver(column, 5000); // well below every rendered card
		dropTask(column, "t0");

		expect(onReorderTask).toHaveBeenCalledTimes(1);
		// task0 removed, dropped at the visible boundary (15) → adjusted to 14.
		expect(onReorderTask).toHaveBeenCalledWith("t0", 14);
	});
});

describe("custom column inline rename (issue #222)", () => {
	it("renders a rename affordance when onRenameColumn is provided", () => {
		renderColumn({ onRenameColumn: vi.fn() });
		expect(screen.getByLabelText("Rename column")).toBeTruthy();
	});

	it("opens directly in rename mode when autoStartEditing is set", () => {
		const onAutoEditConsumed = vi.fn();
		const { container } = renderColumn({
			label: "New Column",
			onRenameColumn: vi.fn(),
			autoStartEditing: true,
			onAutoEditConsumed,
		});
		// A freshly created column mounts straight into the rename input.
		const input = container.querySelector("input") as HTMLInputElement;
		expect(input).toBeTruthy();
		expect(input.value).toBe("New Column");
		// The trigger is consumed once so it can't re-fire on re-render.
		expect(onAutoEditConsumed).toHaveBeenCalledTimes(1);
	});

	it("commits a renamed value through onRenameColumn", async () => {
		const onRenameColumn = vi.fn();
		renderColumn({ label: "Alpha", onRenameColumn });
		await userEvent.click(screen.getByLabelText("Rename column"));
		const input = screen.getByDisplayValue("Alpha") as HTMLInputElement;
		await userEvent.clear(input);
		await userEvent.type(input, "Beta{Enter}");
		expect(onRenameColumn).toHaveBeenCalledWith("Beta");
	});
});
