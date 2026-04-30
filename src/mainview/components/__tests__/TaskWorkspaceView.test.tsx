import { useEffect } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project, Task } from "../../../shared/types";
import TaskWorkspaceView from "../TaskWorkspaceView";

// Tracks TaskTerminal mount lifecycle so the `key={taskId}` regression
// test below can assert that a fresh instance is mounted per task.
const mountLog: string[] = [];
const unmountLog: string[] = [];

vi.mock("../TaskInfoPanel", () => ({
	default: ({ onOpenInlineDiff }: { onOpenInlineDiff?: (request: { mode: "branch"; compareLabel: string; focusFile?: string }) => void }) => (
		<button onClick={() => onOpenInlineDiff?.({ mode: "branch", compareLabel: "origin/main" })}>
			Open Inline Diff
		</button>
	),
}));

vi.mock("../TaskTerminal", () => ({
	default: ({ taskId }: { taskId: string }) => {
		useEffect(() => {
			mountLog.push(taskId);
			return () => {
				unmountLog.push(taskId);
			};
		}, [taskId]);
		return <div data-testid="terminal-view">terminal:{taskId}</div>;
	},
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
	beforeEach(() => {
		mountLog.length = 0;
		unmountLog.length = 0;
	});

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

	// Regression test for the `key={taskId}` prop on TaskTerminal in
	// TaskWorkspacePane (decision 041). Without the key, switching taskId
	// keeps the same TaskTerminal instance mounted, so its cached `ptyUrl`
	// state from the previous task is briefly rendered with the new taskId
	// — causing TerminalView to remount twice and producing the
	// "clean of screen of the task we leave" flicker. With the key, the
	// old TaskTerminal unmounts and a fresh instance mounts.
	it("remounts TaskTerminal when taskId changes (key={taskId})", () => {
		const otherTask: Task = { ...task, id: "t2", title: "Other Task", worktreePath: "/tmp/wt/t2", branchName: "dev3/task-t2" };

		const { rerender } = render(
			<TaskWorkspaceView
				projectId="p1"
				taskId="t1"
				tasks={[task, otherTask]}
				projects={[project]}
				navigate={vi.fn()}
				dispatch={vi.fn()}
			/>,
		);

		expect(mountLog).toEqual(["t1"]);
		expect(unmountLog).toEqual([]);
		expect(screen.getByTestId("terminal-view")).toHaveTextContent("terminal:t1");

		rerender(
			<TaskWorkspaceView
				projectId="p1"
				taskId="t2"
				tasks={[task, otherTask]}
				projects={[project]}
				navigate={vi.fn()}
				dispatch={vi.fn()}
			/>,
		);

		// The old instance must unmount and a brand-new one must mount.
		// If `key={taskId}` is ever removed, this test fails with
		// mountLog=["t1"] (same instance reused with new props).
		expect(mountLog).toEqual(["t1", "t2"]);
		expect(unmountLog).toEqual(["t1"]);
		expect(screen.getByTestId("terminal-view")).toHaveTextContent("terminal:t2");
	});
});
