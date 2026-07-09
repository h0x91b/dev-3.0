import { useEffect, type ReactElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project, SharedArtifact, Task } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import TaskWorkspaceView from "../TaskWorkspaceView";

const getTasksMock = vi.fn();
const exitCopyModeAllPanesMock = vi.fn((_params: { taskId: string }) => Promise.resolve());

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getTasks: (params: { projectId: string }) => getTasksMock(params),
			exitCopyModeAllPanes: (params: { taskId: string }) => exitCopyModeAllPanesMock(params),
		},
	},
	isElectrobun: false,
}));

// Stub analytics so opening the inline diff doesn't fire a real GA network hit.
vi.mock("../../analytics", () => ({
	trackDiffView: vi.fn(),
	trackEvent: vi.fn(),
	trackPageView: vi.fn(),
	agentNameFromId: vi.fn(() => "unknown"),
}));

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

vi.mock("../TaskArtifactViewer", () => ({
	default: ({ artifacts, onClose }: { artifacts: SharedArtifact[]; onClose: () => void }) => (
		<div data-testid="artifact-workspace">
			{artifacts[0]?.title}
			<button onClick={onClose}>Close Artifact</button>
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

const renderWorkspace = (element: ReactElement) => render(element, { wrapper: I18nProvider });

describe("TaskWorkspaceView", () => {
	beforeEach(() => {
		mountLog.length = 0;
		unmountLog.length = 0;
		getTasksMock.mockReset();
		getTasksMock.mockResolvedValue([]);
		exitCopyModeAllPanesMock.mockClear();
		localStorage.removeItem("dev3-artifact-panel-width");
	});

	// Regression: the fullscreen task view can be entered for a task whose
	// project's tasks were never loaded into currentProjectTasks (quick-shell
	// scratch op, toast / notification click into another project). Before the
	// fix the view never fetched them, so `task` stayed undefined and the header
	// chrome (TaskInfoPanel) silently disappeared. It must load its project's
	// tasks on mount and hydrate the store so the chrome renders.
	it("loads its project's tasks on mount and hydrates the store", async () => {
		const dispatch = vi.fn();
		getTasksMock.mockResolvedValue([task]);

		renderWorkspace(
			<TaskWorkspaceView
				projectId="p1"
				taskId="t1"
				tasks={[]}
				projects={[project]}
				navigate={vi.fn()}
				dispatch={dispatch}
			/>,
		);

		await waitFor(() => expect(getTasksMock).toHaveBeenCalledWith({ projectId: "p1" }));
		await waitFor(() =>
			expect(dispatch).toHaveBeenCalledWith({ type: "setTasks", tasks: [task] }),
		);
	});

	it("toggles between terminal and inline diff", async () => {
		const user = userEvent.setup();

		renderWorkspace(
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

	it("shows a task artifact beside the terminal and closes it independently", async () => {
		const onClose = vi.fn();
		const artifact: SharedArtifact = {
			id: "artifact-1",
			kind: "html",
			title: "Metrics",
			name: "metrics.html",
			storedPath: "/tmp/shared-artifacts/artifact-1/metrics.html",
			originalPath: "/tmp/metrics.html",
			bytes: 10,
			createdAt: 1,
			assets: [],
		};
		renderWorkspace(
			<TaskWorkspaceView
				projectId="p1"
				taskId="t1"
				tasks={[task]}
				projects={[project]}
				navigate={vi.fn()}
				dispatch={vi.fn()}
				artifactViewer={{ taskId: "t1", artifacts: [artifact], index: 0 }}
				onCloseArtifactViewer={onClose}
			/>,
		);
		expect(screen.getByTestId("terminal-view")).toBeInTheDocument();
		expect(screen.getByTestId("artifact-workspace")).toHaveTextContent("Metrics");
		const separator = screen.getByRole("separator", { name: "Resize artifact panel" });
		expect(separator).toHaveClass("w-[7px]");
		expect(screen.getByTestId("artifact-resize-grip")).toHaveClass("w-[3px]");
		expect(separator).toHaveAttribute("aria-valuenow", "560");
		separator.focus();
		await userEvent.keyboard("{ArrowLeft}");
		expect(separator).toHaveAttribute("aria-valuenow", "584");
		const setPointerCapture = vi.fn();
		const releasePointerCapture = vi.fn();
		Object.defineProperties(separator, {
			setPointerCapture: { value: setPointerCapture },
			releasePointerCapture: { value: releasePointerCapture },
			hasPointerCapture: { value: () => true },
		});
		fireEvent.pointerDown(separator, { pointerId: 7, clientX: 900 });
		expect(setPointerCapture).toHaveBeenCalledWith(7);
		expect(screen.getByTestId("artifact-resize-shield")).toBeInTheDocument();
		fireEvent.pointerMove(separator, { pointerId: 7, clientX: 850 });
		fireEvent.pointerUp(separator, { pointerId: 7, clientX: 850 });
		expect(releasePointerCapture).toHaveBeenCalledWith(7);
		expect(screen.queryByTestId("artifact-resize-shield")).not.toBeInTheDocument();
		expect(document.body.style.cursor).toBe("");
		expect(document.body.style.userSelect).toBe("");
		await userEvent.click(screen.getByText("Close Artifact"));
		expect(onClose).toHaveBeenCalledOnce();
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

		const { rerender } = renderWorkspace(
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
