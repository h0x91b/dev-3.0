import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Project, Task } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import ProjectView from "../ProjectView";

vi.mock("../../rpc", () => ({
	api: { request: { getTasks: vi.fn().mockResolvedValue([]), getAgents: vi.fn().mockResolvedValue([]) } },
	isElectrobun: true,
}));

// Heavy children — stub so the test focuses on ProjectView's own layout logic.
vi.mock("../KanbanBoard", () => ({
	default: ({ onOpenUnresolvedComments }: { onOpenUnresolvedComments?: (task: Task) => void }) => (
		<div data-testid="kanban">
			<button type="button" data-testid="open-unresolved-from-board" onClick={() => onOpenUnresolvedComments?.({ id: "t1" } as Task)} />
		</div>
	),
}));
vi.mock("../TaskInfoPanel", () => ({ default: () => <div data-testid="info-panel" /> }));
vi.mock("../ActiveTasksSidebar", () => ({ default: () => <div data-testid="sidebar" /> }));
vi.mock("../TaskWorkspacePane", () => ({
	default: ({ inlineDiffRequest }: { inlineDiffRequest?: { focusFirstUnresolvedThread?: boolean } }) => (
		<div data-testid="workspace">
			{inlineDiffRequest?.focusFirstUnresolvedThread && <span data-testid="workspace-unresolved-diff" />}
		</div>
	),
}));
vi.mock("../SplitLayout", () => ({
	default: (props: { kanbanContent: React.ReactNode; terminalContent: React.ReactNode }) => (
		<div>
			<div data-testid="left">{props.kanbanContent}</div>
			<div data-testid="right">{props.terminalContent}</div>
		</div>
	),
}));

const project: Project = {
	id: "p1",
	name: "Alpha",
	path: "/a",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "",
};

function renderView(props: Partial<React.ComponentProps<typeof ProjectView>>) {
	const tasks: Task[] = props.tasks ?? [];
	return render(
		<I18nProvider>
			<ProjectView
				projectId="p1"
				projects={[project]}
				tasks={tasks}
				dispatch={vi.fn()}
				navigate={vi.fn()}
				bellCounts={new Map()}
				taskPorts={new Map()}
				{...props}
			/>
		</I18nProvider>,
	);
}

describe("ProjectView task-view layout", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.removeItem("dev3-task-open-mode");
	});

	it("does not replace a pushed scheduled task with an older initial task snapshot", async () => {
		let resolveTasks: (tasks: Task[]) => void;
		const pendingTasks = new Promise<Task[]>((resolve) => {
			resolveTasks = resolve;
		});
		const { api } = await import("../../rpc");
		vi.mocked(api.request.getTasks).mockReturnValueOnce(pendingTasks);
		const dispatch = vi.fn();

		renderView({ dispatch });
		await waitFor(() => expect(api.request.getTasks).toHaveBeenCalledWith({ projectId: "p1" }));

		window.dispatchEvent(new CustomEvent("rpc:taskUpdated", {
			detail: { task: { id: "scheduled-task", projectId: "p1" } },
		}));
		resolveTasks!([]);

		await Promise.resolve();
		expect(dispatch).not.toHaveBeenCalledWith({ type: "setTasks", projectId: "p1", tasks: [] });
	});

	it("shows the empty-terminal placeholder when taskView is set but no task is selected", async () => {
		renderView({ taskView: true });
		await waitFor(() => expect(screen.getByTestId("sidebar")).toBeInTheDocument());
		expect(screen.getByText("Select a task to see its terminal")).toBeInTheDocument();
		expect(screen.queryByTestId("workspace")).not.toBeInTheDocument();
	});

	it("renders the task workspace (no placeholder) when a task is active", async () => {
		const task = { id: "t1", projectId: "p1", title: "T", status: "in-progress" } as unknown as Task;
		renderView({ activeTaskId: "t1", tasks: [task] });
		await waitFor(() => expect(screen.getByTestId("workspace")).toBeInTheDocument());
		expect(screen.queryByText("Select a task to see its terminal")).not.toBeInTheDocument();
	});

	it("renders only the Kanban board when neither activeTaskId nor taskView is set", async () => {
		renderView({});
		await waitFor(() => expect(screen.getByTestId("kanban")).toBeInTheDocument());
		expect(screen.queryByTestId("sidebar")).not.toBeInTheDocument();
		expect(screen.queryByText("Select a task to see its terminal")).not.toBeInTheDocument();
	});

	it("opens unresolved comments from Kanban in the configured split task route", async () => {
		const navigate = vi.fn();
		renderView({ navigate });

		await userEvent.click(screen.getByTestId("open-unresolved-from-board"));

		expect(navigate).toHaveBeenCalledWith({
			screen: "project",
			projectId: "p1",
			activeTaskId: "t1",
			openUnresolvedComments: true,
		});
	});

	it("uses the fullscreen task route when that open mode is configured", async () => {
		localStorage.setItem("dev3-task-open-mode", "fullscreen");
		const navigate = vi.fn();
		renderView({ navigate });

		await userEvent.click(screen.getByTestId("open-unresolved-from-board"));

		expect(navigate).toHaveBeenCalledWith({
			screen: "task",
			projectId: "p1",
			taskId: "t1",
			openUnresolvedComments: true,
		});
	});

	it("opens the inline diff when the split route carries the unresolved-comments flag", async () => {
		const task = { id: "t1", projectId: "p1", title: "T", status: "in-progress", baseBranch: "main", branchName: "feature/t1" } as unknown as Task;
		renderView({ activeTaskId: "t1", tasks: [task], openUnresolvedComments: true });

		await waitFor(() => expect(screen.getByTestId("workspace-unresolved-diff")).toBeInTheDocument());
	});
});

describe("ProjectView narrow viewport (mobile zoom)", () => {
	const originalInnerWidth = window.innerWidth;
	const originalMatchMedia = window.matchMedia;

	beforeEach(() => {
		vi.clearAllMocks();
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
		Object.defineProperty(window, "matchMedia", {
			configurable: true,
			value: (query: string) => ({
				matches: true,
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

	afterEach(() => {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
		Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
	});

	it("zooms the task workspace and hides the active-tasks sidebar", async () => {
		const task = { id: "t1", projectId: "p1", title: "T", status: "in-progress" } as unknown as Task;
		renderView({ activeTaskId: "t1", tasks: [task] });
		await waitFor(() => expect(screen.getByTestId("workspace")).toBeInTheDocument());
		expect(screen.queryByTestId("sidebar")).not.toBeInTheDocument();
		expect(screen.getByTestId("info-panel")).toBeInTheDocument();
	});
});
