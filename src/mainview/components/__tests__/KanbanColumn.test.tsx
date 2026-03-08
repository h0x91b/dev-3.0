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
import type { Project } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: { request: { moveTask: vi.fn(), deleteTask: vi.fn() } },
}));
vi.mock("../../analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("../../utils/confirmTaskCompletion", () => ({
	confirmTaskCompletion: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../utils/ansi-to-html", () => ({ ansiToHtml: vi.fn((s: string) => s) }));
vi.mock("../TaskDetailModal", () => ({ default: () => null }));
vi.mock("../LabelPicker", () => ({ default: () => null }));

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
				onTaskDrop={vi.fn()}
				onReorderTask={vi.fn()}
				dragFromStatus={null}
				dragFromCustomColumnId={null}
				onDragStart={vi.fn()}
				onTaskMoved={vi.fn()}
				bellCounts={new Map()}
				draggedTaskId={null}
				movingTaskIds={new Set()}
				siblingMap={new Map()}
				isCustomColumn
				customColumnId={overrides.customColumnId ?? "col-aaa"}
				colorOverride="#ff0000"
				onColumnDragStart={vi.fn()}
				onColumnDragEnd={vi.fn()}
				onColumnDrop={overrides.onColumnDrop}
				isDraggedColumn={overrides.isDraggedColumn}
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
			expect(document.querySelector("[class*='-left-3']")).toBeInTheDocument();
			expect(document.querySelector("[class*='-right-3']")).not.toBeInTheDocument();
		});

		it("shows 'after' indicator (clientX > center=0)", () => {
			renderColumn({ onColumnDrop: vi.fn(), customColumnId: "col-target" });
			setupColumnDragFromOther();
			dispatch(getColumn(), "dragover", { clientX: 1 });
			expect(document.querySelector("[class*='-right-3']")).toBeInTheDocument();
			expect(document.querySelector("[class*='-left-3']")).not.toBeInTheDocument();
		});

		it("clears indicator on dragleave", () => {
			renderColumn({ onColumnDrop: vi.fn(), customColumnId: "col-target" });
			setupColumnDragFromOther();
			dispatch(getColumn(), "dragover", { clientX: -1 });
			expect(document.querySelector("[class*='-left-3']")).toBeInTheDocument();

			act(() => { getColumn().dispatchEvent(new MouseEvent("dragleave", { bubbles: true })); });
			expect(document.querySelector("[class*='-left-3']")).not.toBeInTheDocument();
		});

		it("no indicator when no column drag is active", () => {
			renderColumn({ onColumnDrop: vi.fn() });
			dispatch(getColumn(), "dragover", { clientX: -1 });
			expect(document.querySelector("[class*='-left-3']")).not.toBeInTheDocument();
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
			expect(document.querySelector("[class*='-left-3']")).toBeInTheDocument();
			dispatch(getColumn(), "drop");
			expect(document.querySelector("[class*='-left-3']")).not.toBeInTheDocument();
		});
	});
});
