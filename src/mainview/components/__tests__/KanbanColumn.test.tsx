/**
 * KanbanColumn — column drag-and-drop reordering tests.
 *
 * These tests specify the exact events and behaviors required for column
 * reordering to work. If any test fails the drag-and-drop is broken.
 *
 * Testing approach:
 * - Use native `dispatchEvent` + `Object.defineProperty` for `dataTransfer`
 *   because happy-dom doesn't support setting `dataTransfer` via event init.
 * - Wrap all dispatches in `act()` so React flushes state updates before assertions.
 * - Happy-dom elements have zero bounding rects (left=0, width=0, center=0).
 *   Use clientX < 0 for "before" and clientX > 0 for "after" to avoid needing
 *   getBoundingClientRect mocks.
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

function makeDataTransfer(types: string[], data: Record<string, string> = {}): DataTransfer {
	return {
		types,
		getData: (key: string) => data[key] ?? "",
		setData: vi.fn(),
		effectAllowed: "move",
		dropEffect: "move",
	} as unknown as DataTransfer;
}

/** Dispatch a drag event with a properly-set dataTransfer and return defaultPrevented. */
function dispatchDragEvent(
	el: Element,
	type: string,
	options: { dataTransfer?: DataTransfer; clientX?: number } = {},
): boolean {
	const event = new MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		clientX: options.clientX ?? 0,
	});
	if (options.dataTransfer) {
		Object.defineProperty(event, "dataTransfer", { value: options.dataTransfer });
	}
	let defaultPrevented = false;
	act(() => {
		defaultPrevented = !el.dispatchEvent(event);
	});
	return defaultPrevented;
}

function renderCustomColumn(overrides: {
	onColumnDrop?: (side: "before" | "after") => void;
	isDraggedColumn?: boolean;
} = {}) {
	return render(
		<I18nProvider>
			<KanbanColumn
				status="todo"
				label="My Column"
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
				customColumnId="col-aaa"
				colorOverride="#ff0000"
				onColumnDragStart={vi.fn()}
				onColumnDragEnd={vi.fn()}
				{...overrides}
			/>
		</I18nProvider>,
	);
}

function getColumn() {
	return screen.getByText("My Column").closest("[class*='glass-column']") as HTMLElement;
}

describe("KanbanColumn — column drag-and-drop", () => {
	describe("dragover", () => {
		it("calls preventDefault when dev3/column is in dataTransfer types", () => {
			renderCustomColumn({ onColumnDrop: vi.fn() });
			const prevented = dispatchDragEvent(getColumn(), "dragover", {
				dataTransfer: makeDataTransfer(["dev3/column"]),
			});
			expect(prevented).toBe(true);
		});

		it("does NOT call preventDefault for non-column drags (no dev3/column type)", () => {
			renderCustomColumn({ onColumnDrop: vi.fn() });
			const prevented = dispatchDragEvent(getColumn(), "dragover", {
				dataTransfer: makeDataTransfer(["text/plain"]),
			});
			expect(prevented).toBe(false);
		});

		it("does NOT call preventDefault when isDraggedColumn (self-drop guard)", () => {
			renderCustomColumn({ onColumnDrop: vi.fn(), isDraggedColumn: true });
			const prevented = dispatchDragEvent(getColumn(), "dragover", {
				dataTransfer: makeDataTransfer(["dev3/column"]),
			});
			expect(prevented).toBe(false);
		});

		it("does NOT call preventDefault when onColumnDrop is not provided", () => {
			renderCustomColumn({ onColumnDrop: undefined });
			const prevented = dispatchDragEvent(getColumn(), "dragover", {
				dataTransfer: makeDataTransfer(["dev3/column"]),
			});
			expect(prevented).toBe(false);
		});
	});

	describe("dragenter", () => {
		it("calls preventDefault when dev3/column is in dataTransfer types", () => {
			renderCustomColumn({ onColumnDrop: vi.fn() });
			const prevented = dispatchDragEvent(getColumn(), "dragenter", {
				dataTransfer: makeDataTransfer(["dev3/column"]),
			});
			expect(prevented).toBe(true);
		});

		it("does NOT call preventDefault when isDraggedColumn", () => {
			renderCustomColumn({ onColumnDrop: vi.fn(), isDraggedColumn: true });
			const prevented = dispatchDragEvent(getColumn(), "dragenter", {
				dataTransfer: makeDataTransfer(["dev3/column"]),
			});
			expect(prevented).toBe(false);
		});
	});

	describe("drop position indicator", () => {
		// Happy-dom bounding rect is all zeros → center = 0.
		// clientX < 0 → "before", clientX > 0 → "after"

		it("shows 'before' indicator when cursor is in left half (clientX < center)", () => {
			renderCustomColumn({ onColumnDrop: vi.fn() });
			dispatchDragEvent(getColumn(), "dragover", {
				dataTransfer: makeDataTransfer(["dev3/column"]),
				clientX: -1,
			});
			expect(document.querySelector("[class*='-left-3']")).toBeInTheDocument();
			expect(document.querySelector("[class*='-right-3']")).not.toBeInTheDocument();
		});

		it("shows 'after' indicator when cursor is in right half (clientX > center)", () => {
			renderCustomColumn({ onColumnDrop: vi.fn() });
			dispatchDragEvent(getColumn(), "dragover", {
				dataTransfer: makeDataTransfer(["dev3/column"]),
				clientX: 1,
			});
			expect(document.querySelector("[class*='-right-3']")).toBeInTheDocument();
			expect(document.querySelector("[class*='-left-3']")).not.toBeInTheDocument();
		});

		it("clears indicator on dragleave", () => {
			renderCustomColumn({ onColumnDrop: vi.fn() });
			dispatchDragEvent(getColumn(), "dragover", {
				dataTransfer: makeDataTransfer(["dev3/column"]),
				clientX: -1,
			});
			expect(document.querySelector("[class*='-left-3']")).toBeInTheDocument();

			act(() => { getColumn().dispatchEvent(new MouseEvent("dragleave", { bubbles: true })); });
			expect(document.querySelector("[class*='-left-3']")).not.toBeInTheDocument();
		});

		it("no indicator when dev3/column type is absent", () => {
			renderCustomColumn({ onColumnDrop: vi.fn() });
			dispatchDragEvent(getColumn(), "dragover", {
				dataTransfer: makeDataTransfer(["text/plain"]),
				clientX: -1,
			});
			expect(document.querySelector("[class*='-left-3']")).not.toBeInTheDocument();
			expect(document.querySelector("[class*='-right-3']")).not.toBeInTheDocument();
		});
	});

	describe("drop", () => {
		it("calls onColumnDrop('before') when dropped on left half", () => {
			const onColumnDrop = vi.fn();
			renderCustomColumn({ onColumnDrop });
			// Set side via dragover first
			dispatchDragEvent(getColumn(), "dragover", {
				dataTransfer: makeDataTransfer(["dev3/column"]),
				clientX: -1,
			});
			// Drop
			dispatchDragEvent(getColumn(), "drop", {
				dataTransfer: makeDataTransfer(["dev3/column"], { "dev3/column": "col-bbb" }),
			});
			expect(onColumnDrop).toHaveBeenCalledTimes(1);
			expect(onColumnDrop).toHaveBeenCalledWith("before");
		});

		it("calls onColumnDrop('after') when dropped on right half", () => {
			const onColumnDrop = vi.fn();
			renderCustomColumn({ onColumnDrop });
			dispatchDragEvent(getColumn(), "dragover", {
				dataTransfer: makeDataTransfer(["dev3/column"]),
				clientX: 1,
			});
			dispatchDragEvent(getColumn(), "drop", {
				dataTransfer: makeDataTransfer(["dev3/column"], { "dev3/column": "col-bbb" }),
			});
			expect(onColumnDrop).toHaveBeenCalledWith("after");
		});

		it("does NOT call onColumnDrop for task drops (text/plain only)", () => {
			const onColumnDrop = vi.fn();
			renderCustomColumn({ onColumnDrop });
			dispatchDragEvent(getColumn(), "drop", {
				dataTransfer: makeDataTransfer(["text/plain"], { "text/plain": "task-id-123" }),
			});
			expect(onColumnDrop).not.toHaveBeenCalled();
		});

		it("does NOT call onColumnDrop when no side was set (no preceding dragover)", () => {
			const onColumnDrop = vi.fn();
			renderCustomColumn({ onColumnDrop });
			dispatchDragEvent(getColumn(), "drop", {
				dataTransfer: makeDataTransfer(["dev3/column"], { "dev3/column": "col-bbb" }),
			});
			expect(onColumnDrop).not.toHaveBeenCalled();
		});

		it("clears indicator after drop", () => {
			renderCustomColumn({ onColumnDrop: vi.fn() });
			dispatchDragEvent(getColumn(), "dragover", {
				dataTransfer: makeDataTransfer(["dev3/column"]),
				clientX: -1,
			});
			expect(document.querySelector("[class*='-left-3']")).toBeInTheDocument();

			dispatchDragEvent(getColumn(), "drop", {
				dataTransfer: makeDataTransfer(["dev3/column"], { "dev3/column": "col-bbb" }),
			});
			expect(document.querySelector("[class*='-left-3']")).not.toBeInTheDocument();
		});
	});
});
