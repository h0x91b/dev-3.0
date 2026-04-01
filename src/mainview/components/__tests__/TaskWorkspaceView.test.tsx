import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project, Task } from "../../../shared/types";
import TaskWorkspaceView from "../TaskWorkspaceView";

vi.mock("../TaskInfoPanel", () => ({
	default: ({ onOpenInlineDiff }: { onOpenInlineDiff?: (request: { mode: "branch"; compareLabel: string }) => void }) => (
		<button onClick={() => onOpenInlineDiff?.({ mode: "branch", compareLabel: "origin/main" })}>
			Open Inline Diff
		</button>
	),
}));

vi.mock("../TaskTerminal", () => ({
	default: () => <div data-testid="terminal-view">terminal</div>,
}));

vi.mock("../TaskDiffViewer", () => ({
	default: ({ onBack, request }: { onBack: () => void; request: { mode: string } }) => (
		<div data-testid="diff-viewer">
			<div>{request.mode}</div>
			<button onClick={onBack}>Back</button>
		</div>
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

const task: Task = {
	id: "t1",
	seq: 1,
	projectId: "p1",
	title: "Task",
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
};

describe("TaskWorkspaceView", () => {
	it("toggles between terminal and inline diff", async () => {
		const user = userEvent.setup();

		render(
			<TaskWorkspaceView
				projectId="p1"
				taskId="t1"
				tasks={[task]}
				projects={[project]}
				navigate={vi.fn()}
				dispatch={vi.fn()}
			/>,
		);

		expect(screen.getByTestId("terminal-view")).toBeInTheDocument();
		expect(screen.queryByTestId("diff-viewer")).not.toBeInTheDocument();

		await user.click(screen.getByText("Open Inline Diff"));

		expect(screen.getByTestId("diff-viewer")).toBeInTheDocument();
		expect(screen.getByText("branch")).toBeInTheDocument();

		await user.click(screen.getByText("Back"));

		expect(screen.queryByTestId("diff-viewer")).not.toBeInTheDocument();
		expect(screen.getByTestId("terminal-view")).toBeInTheDocument();
	});
});
