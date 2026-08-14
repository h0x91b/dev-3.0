import { render, screen, fireEvent } from "@testing-library/react";
import TaskNotes from "../task-info-panel/TaskNotes";
import { I18nProvider } from "../../i18n";
import type { Project, Task, TaskNote } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			addTaskNote: vi.fn(),
			updateTaskNote: vi.fn(),
			deleteTaskNote: vi.fn(),
		},
	},
}));

vi.mock("../../toast", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
	ToastHost: () => null,
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

function aiNote(n: number, content = `note ${n}`): TaskNote {
	return {
		id: `n${n}`,
		content,
		source: "ai",
		createdAt: "2025-06-15T10:00:00Z",
		updatedAt: "2025-06-15T10:00:00Z",
	};
}

function makeTask(notes: TaskNote[]): Task {
	return {
		id: "t1",
		seq: 42,
		projectId: "p1",
		title: "Test task",
		description: "",
		status: "in-progress",
		baseBranch: "main",
		worktreePath: "/tmp/wt/t1",
		branchName: "dev3/task-t1",
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2025-06-15T10:30:00Z",
		updatedAt: "2025-06-15T12:00:00Z",
		notes,
	};
}

function renderNotes(notes: TaskNote[], opts?: { variant?: "preview" | "full"; onShowAll?: () => void }) {
	return render(
		<I18nProvider>
			<TaskNotes
				task={makeTask(notes)}
				project={project}
				dispatch={vi.fn()}
				variant={opts?.variant}
				onShowAll={opts?.onShowAll}
			/>
		</I18nProvider>,
	);
}

/** happy-dom reports 0 for both metrics, so overflow has to be simulated. */
function forceOverflow(overflowing: boolean) {
	Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
		configurable: true,
		get: () => (overflowing ? 400 : 100),
	});
	Object.defineProperty(HTMLElement.prototype, "clientHeight", {
		configurable: true,
		get: () => 100,
	});
}

describe("TaskNotes", () => {
	afterEach(() => {
		// @ts-expect-error — restoring the happy-dom defaults
		delete HTMLElement.prototype.scrollHeight;
		// @ts-expect-error — restoring the happy-dom defaults
		delete HTMLElement.prototype.clientHeight;
	});

	it("renders every note when the task has at most the preview count", () => {
		renderNotes([aiNote(1), aiNote(2), aiNote(3)]);

		expect(screen.getByText("note 1")).toBeTruthy();
		expect(screen.getByText("note 3")).toBeTruthy();
		expect(screen.queryByTestId("task-notes-show-all")).toBeNull();
	});

	it("keeps only the newest three notes inline and offers the full log", () => {
		const onShowAll = vi.fn();
		renderNotes([aiNote(1), aiNote(2), aiNote(3), aiNote(4), aiNote(5)], { onShowAll });

		expect(screen.queryByText("note 1")).toBeNull();
		expect(screen.queryByText("note 2")).toBeNull();
		expect(screen.getByText("note 3")).toBeTruthy();
		expect(screen.getByText("note 5")).toBeTruthy();

		const showAll = screen.getByTestId("task-notes-show-all");
		expect(showAll.textContent).toContain("5");
		fireEvent.click(showAll);
		expect(onShowAll).toHaveBeenCalledOnce();
	});

	it("shows the total count next to the section title", () => {
		renderNotes([aiNote(1), aiNote(2), aiNote(3), aiNote(4)], { onShowAll: vi.fn() });
		expect(screen.getByTestId("task-notes-count").textContent).toBe("4");
	});

	it("renders the whole log without a show-all row in the full variant", () => {
		renderNotes([aiNote(1), aiNote(2), aiNote(3), aiNote(4), aiNote(5)], { variant: "full", onShowAll: vi.fn() });

		expect(screen.getByText("note 1")).toBeTruthy();
		expect(screen.getByText("note 5")).toBeTruthy();
		expect(screen.queryByTestId("task-notes-show-all")).toBeNull();
	});

	it("has no show-all row when no full-log surface is wired", () => {
		renderNotes([aiNote(1), aiNote(2), aiNote(3), aiNote(4)]);
		expect(screen.queryByTestId("task-notes-show-all")).toBeNull();
	});

	it("clamps an agent note and unfolds it on demand", () => {
		forceOverflow(true);
		renderNotes([aiNote(1, "a very long agent note")]);

		const body = screen.getByTestId("note-body");
		expect(body.className).toContain("line-clamp-6");

		const toggle = screen.getByText("Show more");
		fireEvent.click(toggle);
		expect(screen.getByTestId("note-body").className).not.toContain("line-clamp-6");
		expect(screen.getByText("Show less")).toBeTruthy();
	});

	it("offers no unfold affordance on a note that already fits", () => {
		forceOverflow(false);
		renderNotes([aiNote(1, "short")]);

		expect(screen.getByTestId("note-body").className).toContain("line-clamp-6");
		expect(screen.queryByText("Show more")).toBeNull();
	});
});
