import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Project, Task } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import ProjectView from "../ProjectView";

vi.mock("../../rpc", () => ({
	api: { request: { getTasks: vi.fn().mockResolvedValue([]), getAgents: vi.fn().mockResolvedValue([]) } },
	isElectrobun: true,
}));

// Heavy children — stub so the test focuses on ProjectView's own layout logic.
vi.mock("../KanbanBoard", () => ({ default: () => <div data-testid="kanban" /> }));
vi.mock("../TaskInfoPanel", () => ({ default: () => <div data-testid="info-panel" /> }));
vi.mock("../ActiveTasksSidebar", () => ({ default: () => <div data-testid="sidebar" /> }));
vi.mock("../ActiveTasksStrip", () => ({ default: () => <div data-testid="strip" /> }));
vi.mock("../TaskWorkspacePane", () => ({ default: () => <div data-testid="workspace" /> }));
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
	beforeEach(() => vi.clearAllMocks());

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
});
